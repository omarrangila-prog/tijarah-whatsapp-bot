import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KnownParty } from './known-party.entity';
import { matchParty, type PartyCandidate, type PartyMatch } from './party-match';
import { normalizeWhatsAppNumber } from '../providers/whatsapp-delivery.provider';
// A VALUE import, not `import type`: Nest reads the constructor's emitted design:paramtypes to
// know what to inject, and a type-only import is erased, leaving `undefined` and a boot-time
// "can't resolve dependencies of KnownPartyService" that no unit test sees.
import { BotUserService } from './bot-user.service';
import type { TenantContext } from './bot-user.service';
import { createLogger } from '../../../common/services/logger.service';

/**
 * The names of a client's customers, learned from the documents the host sends them.
 *
 * Tijarah's account list has codes and phone numbers but no names, so a person had to quote
 * "C-1005" to get a ledger. The queue names the customer on every document it asks to be
 * delivered, so those names are kept here as they pass, and a name a person types is matched
 * against them.
 *
 * The account code is resolved by phone number against the host's own account list, never
 * invented: a name alone cannot fetch a ledger, and a wrong code would fetch somebody else's.
 */
@Injectable()
export class KnownPartyService {
  private readonly logger = createLogger('KnownPartyService');

  constructor(
    @InjectRepository(KnownParty, 'data') private readonly parties: Repository<KnownParty>,
    private readonly users: BotUserService,
  ) {}

  /**
   * Record a customer's name, as seen on a document being delivered to them.
   *
   * Keyed on the phone within one company, so the business renaming a customer updates the
   * row rather than accumulating duplicates. Never throws: this runs inside the delivery
   * path, and a document must not fail to arrive because a name could not be remembered.
   */
  async remember(tenant: Pick<TenantContext, 'sid' | 'grp'>, name: string, phone: string): Promise<void> {
    const trimmed = name.trim();
    const normalised = normalizeWhatsAppNumber(phone);
    if (!trimmed || !normalised) return;

    try {
      const existing = await this.parties.findOne({
        where: { sid: tenant.sid, grp: tenant.grp, phone: normalised },
      });
      if (existing) {
        existing.name = trimmed.slice(0, 190);
        existing.lastSeenAt = new Date();
        await this.parties.save(existing);
        return;
      }
      await this.parties.save(
        this.parties.create({
          sid: tenant.sid,
          grp: tenant.grp,
          phone: normalised,
          name: trimmed.slice(0, 190),
          lcode: null,
          lastSeenAt: new Date(),
          createdAt: new Date(),
        }),
      );
    } catch (error) {
      // A unique-index race (the same customer on two documents at once) lands here; so does a
      // database hiccup. Either way the document is what matters.
      this.logger.warn(`could not remember "${trimmed}": ${(error as Error).message}`);
    }
  }

  /** Every customer known in this company's books. */
  async list(tenant: Pick<TenantContext, 'sid' | 'grp'>): Promise<PartyCandidate[]> {
    const rows = await this.parties.find({
      where: { sid: tenant.sid, grp: tenant.grp },
      order: { lastSeenAt: 'DESC' },
      take: 500,
    });
    return rows.map(row => ({ name: row.name, phone: row.phone, lcode: row.lcode }));
  }

  /**
   * The customer a person means, with an account code where one can be confirmed.
   *
   * A match with no code yet has the host's account list consulted by phone. Exactly one
   * account for that number is the answer and is cached; several — one number used on two
   * accounts, which the host's data does have — is left unresolved, because choosing would
   * mean sending one customer's ledger under another's name.
   */
  async find(tenant: TenantContext, query: string): Promise<PartyMatch> {
    const match = matchParty(query, await this.list(tenant));
    if (match.kind !== 'one' || match.party.lcode) return match;

    const accounts = await this.users.findByPhone(tenant, match.party.phone);
    if (accounts.length !== 1) return match;

    const lcode = accounts[0].lcode;
    try {
      await this.parties.update({ sid: tenant.sid, grp: tenant.grp, phone: match.party.phone }, { lcode });
    } catch (error) {
      this.logger.warn(`could not cache the account code for "${match.party.name}": ${(error as Error).message}`);
    }
    return { kind: 'one', party: { ...match.party, lcode } };
  }
}
