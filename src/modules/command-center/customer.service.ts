import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { Message } from '../message/entities/message.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { ContactConsent, ConsentStatus } from './entities/contact-consent.entity';
import { Conversation } from './entities/conversation.entity';
import { normalizeWaId, phoneFromWaId } from './conversation-state';

/** A profile enriched with the facts derived from message history, not stored on the row. */
export interface CustomerView extends CustomerProfile {
  consent: ContactConsent | null;
  /** Sessions this person has ever been reached through. */
  sessionIds: string[];
  messageCount: number;
  conversationIds: string[];
}

export interface CustomerListFilters {
  search?: string;
  customerType?: string;
  consent?: ConsentStatus;
  limit?: number;
  offset?: number;
}

/**
 * Customer 360.
 *
 * Profiles hold only what an operator types in. Everything derivable — how many messages, which
 * numbers they've talked to, when they first appeared — is computed from `messages` and
 * `cc_conversations` at read time so it cannot drift out of sync with the source of truth.
 */
@Injectable()
export class CustomerService {
  constructor(
    @InjectRepository(CustomerProfile, 'data') private readonly profiles: Repository<CustomerProfile>,
    @InjectRepository(ContactConsent, 'data') private readonly consents: Repository<ContactConsent>,
    @InjectRepository(Conversation, 'data') private readonly conversations: Repository<Conversation>,
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
  ) {}

  async list(filters: CustomerListFilters): Promise<{ customers: CustomerView[]; total: number }> {
    const limit = Math.min(Math.max(Math.trunc(filters.limit ?? 50) || 50, 1), 200);
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0) || 0);

    const qb = this.profiles.createQueryBuilder('p');
    const term = filters.search?.trim();
    if (term) {
      const like = `%${term.toLowerCase()}%`;
      qb.andWhere(
        '(LOWER(p.displayName) LIKE :like OR LOWER(p.company) LIKE :like OR LOWER(p.email) LIKE :like OR p.phone LIKE :like OR LOWER(p.waId) LIKE :like)',
        { like },
      );
    }
    if (filters.customerType) qb.andWhere('p.customerType = :customerType', { customerType: filters.customerType });

    if (filters.consent) {
      if (filters.consent === ConsentStatus.UNKNOWN) {
        // "Unknown" must include people with no consent row at all, which is the common case — a
        // plain join would silently hide exactly the contacts the operator is looking for.
        qb.andWhere(
          `NOT EXISTS (SELECT 1 FROM cc_contact_consent cn WHERE cn."waId" = p."waId" AND cn.status <> :unknown)`,
          { unknown: ConsentStatus.UNKNOWN },
        );
      } else {
        qb.andWhere(
          `EXISTS (SELECT 1 FROM cc_contact_consent cn WHERE cn."waId" = p."waId" AND cn.status = :consent)`,
          { consent: filters.consent },
        );
      }
    }

    qb.orderBy('p.lastInteractionAt', 'DESC').addOrderBy('p.id', 'DESC').skip(offset).take(limit);
    const [rows, total] = await qb.getManyAndCount();
    return { customers: await this.decorate(rows), total };
  }

  async getByWaId(waId: string): Promise<CustomerView> {
    const key = normalizeWaId(waId);
    const profile = (await this.profiles.findOne({ where: { waId: key } })) ?? (await this.ensure(key));
    const [view] = await this.decorate([profile]);
    return view;
  }

  /** Create the profile row for a WhatsApp id if it does not exist yet. Idempotent. */
  async ensure(waId: string, seed: Partial<CustomerProfile> = {}): Promise<CustomerProfile> {
    const key = normalizeWaId(waId);
    const existing = await this.profiles.findOne({ where: { waId: key } });
    if (existing) return existing;
    try {
      return await this.profiles.save(this.profiles.create({ waId: key, phone: phoneFromWaId(key), ...seed }));
    } catch {
      // Lost the unique race — the other writer's row is just as good.
      const raced = await this.profiles.findOne({ where: { waId: key } });
      if (raced) return raced;
      throw new NotFoundException(`Customer profile for ${waId} could not be created`);
    }
  }

  async update(waId: string, input: Partial<CustomerProfile>): Promise<CustomerView> {
    const key = normalizeWaId(waId);
    const profile = await this.ensure(key);
    for (const field of ['displayName', 'company', 'email', 'source', 'customerType', 'city'] as const) {
      if (input[field] !== undefined) profile[field] = input[field];
    }
    if (input.customFields !== undefined) {
      profile.customFields = sanitizeCustomFields(input.customFields);
    }
    const saved = await this.profiles.save(profile);
    const [view] = await this.decorate([saved]);
    return view;
  }

  /** Touch the interaction window. Called by the recorder on every message, so it stays cheap. */
  async touch(waId: string, at: Date, name?: string | null): Promise<void> {
    const key = normalizeWaId(waId);
    const profile = await this.ensure(key, { firstInteractionAt: at });
    let dirty = false;
    if (!profile.firstInteractionAt || profile.firstInteractionAt > at) {
      profile.firstInteractionAt = at;
      dirty = true;
    }
    if (!profile.lastInteractionAt || profile.lastInteractionAt < at) {
      profile.lastInteractionAt = at;
      dirty = true;
    }
    // The engine's pushName is a fallback only: it must never overwrite a name the operator typed.
    if (!profile.displayName && name) {
      profile.displayName = name.slice(0, 120);
      dirty = true;
    }
    if (dirty) await this.profiles.save(profile);
  }

  // ---------------------------------------------------------------- consent

  getConsent(waId: string): Promise<ContactConsent | null> {
    return this.consents.findOne({ where: { waId: normalizeWaId(waId) } });
  }

  /**
   * Record a consent decision.
   *
   * OPTED_IN requires a stated source: an opt-in with no provenance is not one you could defend if
   * a recipient complained, so the API refuses it rather than storing a claim it cannot support.
   */
  async setConsent(
    waId: string,
    status: ConsentStatus,
    options: { source?: string | null; recordedBy?: string | null } = {},
  ): Promise<ContactConsent> {
    const key = normalizeWaId(waId);
    if (status === ConsentStatus.OPTED_IN && !options.source?.trim()) {
      throw new BadRequestException('An opt-in must record how consent was obtained (source is required)');
    }
    // Make sure the person exists in the book: consent recorded against someone the Contacts page
    // cannot show is a record nobody can audit or withdraw through the UI.
    await this.ensure(key);
    const now = new Date();
    const existing = await this.consents.findOne({ where: { waId: key } });
    const row =
      existing ??
      this.consents.create({
        waId: key,
        status: ConsentStatus.UNKNOWN,
        source: null,
        optedInAt: null,
        optedOutAt: null,
      });

    row.status = status;
    row.recordedBy = options.recordedBy ?? row.recordedBy ?? null;
    if (status === ConsentStatus.OPTED_IN) {
      row.source = options.source!.trim();
      row.optedInAt = now;
    } else if (status === ConsentStatus.OPTED_OUT) {
      row.optedOutAt = now;
      if (options.source?.trim()) row.source = options.source.trim();
    }
    return this.consents.save(row);
  }

  /** The opted-in subset of a candidate list — the only gate broadcasts are allowed to use. */
  async filterOptedIn(waIds: string[]): Promise<Set<string>> {
    if (waIds.length === 0) return new Set();
    const keys = [...new Set(waIds.map(normalizeWaId))];
    const rows = await this.consents.find({ where: { waId: In(keys), status: ConsentStatus.OPTED_IN } });
    return new Set(rows.map(r => r.waId));
  }

  // -------------------------------------------------------------- internals

  private async decorate(profiles: CustomerProfile[]): Promise<CustomerView[]> {
    if (profiles.length === 0) return [];
    const waIds = profiles.map(p => p.waId);

    const consentRows = await this.consents.find({ where: { waId: In(waIds) } });
    const consentByWaId = new Map(consentRows.map(c => [c.waId, c]));

    // Chat ids are stored in whichever dialect the engine used, so match on both user forms.
    const chatCandidates = waIds.flatMap(waId => [waId, waId.replace('@c.us', '@s.whatsapp.net')]);
    const conversations = await this.conversations.find({ where: { chatId: In(chatCandidates) } });
    const counts = await this.messages
      .createQueryBuilder('m')
      .select('m.chatId', 'chatId')
      .addSelect('COUNT(*)', 'total')
      .where('m.chatId IN (:...chatCandidates)', { chatCandidates })
      .groupBy('m.chatId')
      .getRawMany<{ chatId: string; total: string | number }>();

    return profiles.map(profile => {
      const variants = new Set([profile.waId, profile.waId.replace('@c.us', '@s.whatsapp.net')]);
      const mine = conversations.filter(c => variants.has(c.chatId));
      const messageCount = counts
        .filter(row => variants.has(row.chatId))
        .reduce((sum, row) => sum + Number(row.total || 0), 0);
      return {
        ...profile,
        consent: consentByWaId.get(profile.waId) ?? null,
        sessionIds: [...new Set(mine.map(c => c.sessionId))],
        conversationIds: mine.map(c => c.id),
        messageCount,
      };
    });
  }
}

/**
 * Keep custom fields to a shape the UI can render and the database can hold: string values, a bounded
 * number of keys, and keys that look like identifiers. Anything else is dropped rather than stored,
 * so a malformed import cannot turn a profile into an unreadable blob.
 */
export function sanitizeCustomFields(input: Record<string, unknown> | null): Record<string, string> | null {
  if (!input || typeof input !== 'object') return null;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim().slice(0, 40);
    if (!key || !/^[\w .-]+$/.test(key)) continue;
    if (rawValue === null || rawValue === undefined) continue;
    // Primitives only: an object would stringify to "[object Object]", which is not a field value.
    // A malformed import loses that key rather than storing a placeholder that looks like data.
    const value =
      typeof rawValue === 'string'
        ? rawValue
        : typeof rawValue === 'number' || typeof rawValue === 'boolean' || typeof rawValue === 'bigint'
          ? String(rawValue)
          : null;
    if (value === null || value === '') continue;
    out[key] = value.slice(0, 500);
    if (++count >= 30) break;
  }
  return Object.keys(out).length ? out : null;
}
