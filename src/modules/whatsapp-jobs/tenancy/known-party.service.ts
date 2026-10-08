import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KnownParty } from './known-party.entity';
import { matchParty, normaliseName, type PartyCandidate, type PartyMatch } from './party-match';
import { actHeadForLedger } from './account-kind';
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

  /**
   * The client's accounts as the host lists them, in the form the matcher takes.
   *
   * An account with no name is dropped rather than offered under its code: a menu entry
   * reading "0104014" helps nobody, and matching a typed name against a code cannot succeed.
   * A host failure yields an empty list, which falls through to the learned names.
   */
  private async hostCandidates(tenant: TenantContext, documentType: string): Promise<PartyCandidate[]> {
    try {
      const accounts = await this.users.fetchAccounts(tenant, actHeadForLedger(documentType));
      return accounts
        .filter(a => (a.name ?? '').trim())
        .map(a => ({
          name: (a.name ?? '').trim(),
          phone: normalizeWhatsAppNumber(a.telNo ?? '') ?? '',
          lcode: a.lcode,
        }));
    } catch (error) {
      this.logger.warn(`could not read the account list: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * The item a person means, matched against the client's own stock list.
   *
   * Items are matched the same way parties are — exact, then whole word, then word-start,
   * with two matches asked about rather than chosen — because "Blue Shirt" and "Blue Shirt
   * XL" are different products and sending the wrong item's ledger is the same mistake as
   * sending the wrong customer's.
   */
  async findItem(tenant: TenantContext, query: string): Promise<PartyMatch> {
    const items = await this.users.fetchItems(tenant);
    return matchParty(
      query,
      items.map(i => ({ name: i.name.trim(), phone: '', lcode: i.icode })),
    );
  }

  /**
   * Near names for one that matched nothing: accounts (or items) sharing any whole word with
   * what was typed. "khuzema ahmed" found nobody — the account is KHUZEMA TRADEVIVE — and a
   * flat "could not find" left the person guessing. A shortlist to choose from is never a
   * guess: nothing is sent until they pick one.
   */
  async suggest(
    tenant: TenantContext,
    query: string,
    documentType: string,
    kind: 'party' | 'item',
  ): Promise<PartyCandidate[]> {
    const words = normaliseName(query)
      .split(' ')
      .filter(word => word.length >= 3 && !/^(bhai|sahab|sahib|saab|ledger|item|items|product|account)$/.test(word));
    if (!words.length) return [];
    const pool =
      kind === 'item'
        ? (await this.users.fetchItems(tenant)).map(i => ({ name: i.name.trim(), phone: '', lcode: i.icode }))
        : await this.hostCandidates(tenant, documentType);
    return pool
      .filter(candidate => {
        const name = normaliseName(candidate.name).split(' ');
        return words.some(word => name.includes(word));
      })
      .slice(0, 5);
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
  async find(tenant: TenantContext, query: string, documentType = 'general_ledger'): Promise<PartyMatch> {
    /*
     * As typed first, then without the courtesy words. "daniyal bhai ka ledger" found nobody:
     * every word typed has to be in the account's name, and "bhai" is respect, not the name.
     * Tried second, not first, because some accounts DO carry it — "DANYAL BHAI - (KAUSAR
     * INNOVATIONS)" is a real one — and as typed is the better match whenever it exists.
     */
    const asTyped = await this.findOnce(tenant, query, documentType);
    if (asTyped.kind !== 'none') return asTyped;
    const plain = query
      .split(/\s+/)
      .filter(
        word =>
          !/^(bhai|bhae|bhaijaan|sahab|sahib|saab|sb|ji|jee|mr|mrs|ms|miss|uncle|baji|janab|seth|sir)$/i.test(word),
      )
      .join(' ')
      .trim();
    return plain && plain !== query.trim() ? this.findOnce(tenant, plain, documentType) : asTyped;
  }

  private async findOnce(tenant: TenantContext, query: string, documentType: string): Promise<PartyMatch> {
    /*
     * The host's own chart is searched FIRST, because it is the authority on who exists.
     *
     * `GetBotCustomers` began returning a `name` on 8 October 2026. Before that the only
     * names available were the ones learned from documents as they were delivered, so a
     * customer who had never been sent anything could not be asked for by name at all. Now
     * every account in the client's books is reachable, and the learned names below remain
     * as the fallback for a host that has not been updated — and for the spellings the
     * business actually uses on a document, which are not always the account's own.
     */
    const fromHost = matchParty(query, await this.hostCandidates(tenant, documentType));
    if (fromHost.kind !== 'none') return fromHost;

    const match = matchParty(query, await this.list(tenant));
    if (match.kind !== 'one' || match.party.lcode) return match;

    /*
     * The host is asked with the head that matches the ledger wanted.
     *
     * Only RECEIVABLE and BANK/CASH narrow anything — everything else returns the whole
     * chart — but a narrower list is fewer rows to match a phone against and so fewer ways
     * to come back ambiguous. The code's own prefix is what finally decides the kind.
     */
    const accounts = await this.users.findByPhone(tenant, match.party.phone, actHeadForLedger(documentType));
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
