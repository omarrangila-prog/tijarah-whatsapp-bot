import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Like } from 'typeorm';
import { AgentAdminNumber } from '../../modules/agent/entities/agent-admin-number.entity';
import { CustomerProfile } from '../../modules/command-center/entities/customer-profile.entity';
import type { SenderRole } from './agent-message.types';

/**
 * Who is this number, and what is it allowed to be?
 *
 * Two jobs that must not be confused: deciding the *role* of an incoming sender, and
 * finding the *recipient* an admin meant when they said "Ali".
 *
 * The first is a security decision and is made here, from the allowlist, before the model
 * sees anything. The second is a search that deliberately refuses to guess.
 */

export interface ResolvedSender {
  phoneE164: string;
  role: SenderRole;
  /** The API key this sender acts as, for admins and staff. Null for everyone else. */
  apiKeyId: string | null;
  contactId: string | null;
  displayName: string | null;
  label: string | null;
}

export interface ContactMatch {
  contactId: string;
  waId: string;
  phoneE164: string | null;
  displayName: string | null;
  company: string | null;
  customerType: string | null;
  city: string | null;
  /** Which field matched, so the disambiguation prompt can say why each candidate is here. */
  matchedOn: 'phone' | 'name' | 'company' | 'type';
}

/** Digits only, country code included, no punctuation. The one comparison form. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

@Injectable()
export class ContactMapper {
  constructor(
    @InjectRepository(AgentAdminNumber, 'data') private readonly admins: Repository<AgentAdminNumber>,
    @InjectRepository(CustomerProfile, 'data') private readonly profiles: Repository<CustomerProfile>,
  ) {}

  /**
   * Decides a sender's role.
   *
   * Allowlist first, and only the allowlist can produce `admin` or `staff`. Nothing about
   * the message body participates in this decision — a message claiming to be from the
   * owner is a customer message that says so, and treating those differently is the whole
   * of prompt-injection privilege escalation.
   *
   * The lookup is exact on normalized digits. No prefix matching, no fuzzy matching: a
   * number that is one digit different from an admin's is a different person.
   */
  async resolveSender(rawPhone: string): Promise<ResolvedSender> {
    const phoneE164 = normalizePhone(rawPhone);
    if (!phoneE164) {
      return { phoneE164: '', role: 'unknown', apiKeyId: null, contactId: null, displayName: null, label: null };
    }

    const admin = await this.admins.findOne({ where: { phoneE164, isActive: true } });
    if (admin) {
      return {
        phoneE164,
        role: admin.role === 'staff' ? 'staff' : 'admin',
        apiKeyId: admin.apiKeyId,
        contactId: null,
        displayName: admin.label,
        label: admin.label,
      };
    }

    // Known to the CRM but not on the allowlist: a customer. They get the restricted
    // experience, scoped to their own account.
    const profile = await this.profiles.findOne({ where: { phone: phoneE164 } });
    if (profile) {
      return {
        phoneE164,
        role: 'customer',
        apiKeyId: null,
        contactId: profile.id,
        displayName: profile.displayName ?? profile.company,
        label: profile.company,
      };
    }

    return { phoneE164, role: 'unknown', apiKeyId: null, contactId: null, displayName: null, label: null };
  }

  /**
   * Finds candidate recipients for a name an admin typed.
   *
   * Returns every plausible match rather than the best one, on purpose. "Send Ali the
   * statement" with three Alis on file is not a ranking problem — picking the wrong Ali
   * sends one customer another customer's balance, which is a data breach dressed as a
   * convenience. The caller asks the admin; it never resolves the ambiguity itself.
   *
   * Searches the fields the brief lists: party name, contact-person name, company, phone,
   * and contact role.
   */
  async searchContacts(query: string, limit = 8): Promise<ContactMatch[]> {
    const trimmed = query.trim();
    if (trimmed.length < 2) return [];

    const asPhone = normalizePhone(trimmed);
    const found = new Map<string, ContactMatch>();

    const add = (profile: CustomerProfile, matchedOn: ContactMatch['matchedOn']) => {
      // First match wins its reason: a row found by phone is reported as a phone match even
      // if its name also matches, because that is the stronger signal to show the operator.
      if (found.has(profile.id)) return;
      found.set(profile.id, {
        contactId: profile.id,
        waId: profile.waId,
        phoneE164: normalizePhone(profile.phone),
        displayName: profile.displayName,
        company: profile.company,
        customerType: profile.customerType,
        city: profile.city,
        matchedOn,
      });
    };

    if (asPhone) {
      for (const row of await this.profiles.find({ where: { phone: asPhone }, take: limit })) {
        add(row, 'phone');
      }
    }

    // `Like` with a leading wildcard cannot use an index, which is acceptable at this scale
    // and is why the result set is capped rather than paginated.
    const pattern = `%${escapeLike(trimmed)}%`;
    for (const [field, reason] of [
      ['displayName', 'name'],
      ['company', 'company'],
      ['customerType', 'type'],
    ] as const) {
      if (found.size >= limit) break;
      const rows = await this.profiles.find({ where: { [field]: Like(pattern) } as never, take: limit });
      for (const row of rows) add(row, reason);
    }

    return [...found.values()].slice(0, limit);
  }

  /**
   * The accounting system's id for the customer this number belongs to, or null.
   *
   * Read from the profile's `ledgerId` custom field, which an operator sets when the
   * customer is linked. There is deliberately no fallback to matching on name or company:
   * an unmatched number gets told the account could not be identified, because guessing
   * which "Ali" a stranger's number refers to and then reading out that account's balance
   * is a data breach with a friendly tone. An explicit link or nothing.
   */
  async resolveLedgerId(phoneE164: string): Promise<string | null> {
    const phone = normalizePhone(phoneE164);
    if (!phone) return null;
    const profile = await this.profiles.findOne({ where: { phone } });
    const linked = profile?.customFields?.['ledgerId'];
    return typeof linked === 'string' && linked.trim() ? linked.trim() : null;
  }

  /**
   * Whether this number has asked, over WhatsApp, not to be contacted.
   *
   * Stored on the profile so it is checked from the send path as well as the tool that sets
   * it — an opt-out that only records the request and still lets the next reminder go out
   * is worse than none, because it is on the record that they asked.
   */
  async isOptedOut(phoneE164: string): Promise<boolean> {
    const phone = normalizePhone(phoneE164);
    if (!phone) return false;
    const profile = await this.profiles.findOne({ where: { phone } });
    return profile?.customFields?.['waOptOut'] === 'true';
  }

  /** Records or lifts the opt-out. Returns false when the number is not on file. */
  async setOptOut(phoneE164: string, optedOut: boolean): Promise<boolean> {
    const phone = normalizePhone(phoneE164);
    if (!phone) return false;
    const profile = await this.profiles.findOne({ where: { phone } });
    if (!profile) return false;
    profile.customFields = { ...(profile.customFields ?? {}), waOptOut: optedOut ? 'true' : 'false' };
    await this.profiles.save(profile);
    return true;
  }

  /** Whether a number belongs to the customer it claims, used to fence customer requests. */
  async ownsContact(phoneE164: string, contactId: string): Promise<boolean> {
    const normalized = normalizePhone(phoneE164);
    if (!normalized) return false;
    const profile = await this.profiles.findOne({ where: { id: contactId } });
    return profile !== null && normalizePhone(profile.phone) === normalized;
  }

  async listAdmins(): Promise<AgentAdminNumber[]> {
    return this.admins.find({ order: { createdAt: 'ASC' } });
  }
}

/** `%` and `_` are wildcards in LIKE; a customer named "A_B" must not match everything. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, char => `\\${char}`);
}
