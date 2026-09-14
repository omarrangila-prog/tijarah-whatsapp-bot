import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { request } from 'undici';
import { createLogger } from '../../../common/services/logger.service';
import { BotUser } from './bot-user.entity';
import { normalizeWhatsAppNumber } from '../providers/whatsapp-delivery.provider';

/** A resolved client: which company this number's documents come from. */
export interface TenantContext {
  whatsAppNo: string;
  sid: number;
  grp: string;
  aYear: string;
  displayName: string | null;
}

/** One Tijarah client, as `GetBotTijarahClient` returns it. */
export interface HostClient {
  sid: number;
  grp: string;
  cont: string | null;
  email: string | null;
  businessName: string | null;
  businessAddress?: string | null;
}

/**
 * What asking "who is this number" can come back with.
 *
 * `ambiguous` is its own outcome rather than "the first one": a person whose number is on
 * two Tijarah accounts must say which business they mean before anything is fetched, because
 * the wrong guess shows them the other company's books.
 */
export type TenantLookup =
  { kind: 'registered'; tenant: TenantContext } | { kind: 'ambiguous'; choices: HostClient[] } | { kind: 'unknown' };

/** One account in the host's chart, as `GetBotCustomers` returns it. */
export interface BotAccount {
  lcode: string;
  telNo: string | null;
  email: string | null;
}

/**
 * Resolves who is asking, and looks up accounts in their company.
 *
 * Everything the bot fetches is scoped by `sid` and `grp`, and those belong to the person
 * asking rather than to the installation. A number with no mapping is refused: falling back to
 * a default company would hand one business another's invoices, and it would do it silently.
 */
@Injectable()
export class BotUserService {
  private readonly logger = createLogger('BotUserService');

  constructor(@InjectRepository(BotUser, 'data') private readonly users: Repository<BotUser>) {}

  /**
   * The company this number belongs to, or null when nothing can be served to it.
   *
   * Null covers both "unknown" and "on more than one account" — either way nothing is fetched
   * until the person is registered or has chosen. Callers that can ask the person which
   * business they mean use {@link lookup}, which keeps the two apart.
   */
  async resolve(phone: string): Promise<TenantContext | null> {
    const outcome = await this.lookup(phone);
    return outcome.kind === 'registered' ? outcome.tenant : null;
  }

  /**
   * Who this number is, asking the host when the local table does not know.
   *
   * `bot_users` is consulted first — it is where an administrator's explicit mapping lives,
   * and it is the cache of every answer the host has already given. On a miss the host's own
   * client directory is asked by phone number; one match is remembered and served, several
   * are handed back for the person to choose between, none is refused.
   *
   * A host failure is "unknown", not "try a default". A directory that is briefly down must
   * not turn into a company being guessed.
   */
  async lookup(phone: string): Promise<TenantLookup> {
    const whatsAppNo = normalizeWhatsAppNumber(phone);
    if (!whatsAppNo) return { kind: 'unknown' };

    const user = await this.users.findOne({ where: { whatsAppNo, isActive: true } });
    if (user) {
      return {
        kind: 'registered',
        tenant: { whatsAppNo, sid: user.sid, grp: user.grp, aYear: user.aYear, displayName: user.displayName },
      };
    }

    const clients = await this.findHostClients(whatsAppNo);
    if (clients.length === 1) {
      const saved = await this.remember(whatsAppNo, clients[0]);
      this.logger.log(
        `${whatsAppNo} resolved from the host directory → ${saved.sid}/${saved.grp} (${saved.displayName ?? '-'})`,
      );
      return {
        kind: 'registered',
        tenant: { whatsAppNo, sid: saved.sid, grp: saved.grp, aYear: saved.aYear, displayName: saved.displayName },
      };
    }
    if (clients.length > 1) {
      this.logger.log(`${whatsAppNo} is on ${clients.length} Tijarah accounts — asking which`);
      return { kind: 'ambiguous', choices: clients };
    }

    this.logger.warn(`${whatsAppNo} is not registered to a company — refusing rather than guessing one`);
    return { kind: 'unknown' };
  }

  /**
   * Settles an ambiguous number on the business the person named.
   *
   * Matched on the business name the host gave, case-insensitively and by containment, or on
   * its position in the list they were shown ("1", "2"). One match is remembered; zero or
   * several is null and the person is asked again.
   */
  async choose(phone: string, answer: string, choices: HostClient[]): Promise<TenantContext | null> {
    const whatsAppNo = normalizeWhatsAppNumber(phone);
    const wanted = answer.trim().toLowerCase();
    if (!whatsAppNo || !wanted) return null;

    const byPosition = /^\d{1,2}$/.test(wanted) ? choices[Number(wanted) - 1] : undefined;
    const byName = choices.filter(c => (c.businessName ?? '').toLowerCase().includes(wanted));
    const picked = byPosition ?? (byName.length === 1 ? byName[0] : undefined);
    if (!picked) return null;

    const saved = await this.remember(whatsAppNo, picked);
    return { whatsAppNo, sid: saved.sid, grp: saved.grp, aYear: saved.aYear, displayName: saved.displayName };
  }

  /**
   * The host's client directory, by phone number.
   *
   * Asked in the local form first (`03001234567`, which is how the directory stores numbers)
   * and in the international form only if that finds nothing — one directory, two spellings
   * of the same phone, and the person should not be refused over a country code.
   */
  private async findHostClients(whatsAppNo: string): Promise<HostClient[]> {
    const forms = [toLocalForm(whatsAppNo), whatsAppNo].filter((v, i, all) => all.indexOf(v) === i);
    for (const cont of forms) {
      const rows = await this.queryHostClients({ cont });
      if (rows.length) return rows;
    }
    return [];
  }

  private async queryHostClients(by: { cont?: string; email?: string; bname?: string }): Promise<HostClient[]> {
    const base = (process.env.TIJARAH_QUEUE_BASE_URL ?? 'https://api.tijarabooks.com/BotConnectApi').replace(/\/$/, '');
    // The host treats "0" as "not filtering on this one".
    const url =
      `${base}/GetBotTijarahClient?cont=${encodeURIComponent(by.cont ?? '0')}` +
      `&email=${encodeURIComponent(by.email ?? '0')}&bname=${encodeURIComponent(by.bname ?? '0')}`;
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
      });
      if (res.statusCode >= 400) {
        this.logger.warn(`GetBotTijarahClient responded ${res.statusCode}`);
        return [];
      }
      const body = (await res.body.json()) as { data?: unknown };
      return Array.isArray(body?.data) ? body.data.filter(isHostClient) : [];
    } catch (error) {
      this.logger.warn(`could not read the client directory: ${(error as Error).message}`);
      return [];
    }
  }

  /** Caches a host answer as a bot_users row, so the directory is asked once per number. */
  private async remember(whatsAppNo: string, client: HostClient): Promise<BotUser> {
    const saved = await this.upsert({
      whatsAppNo,
      sid: client.sid,
      grp: client.grp,
      // The directory carries no accounting year; the current calendar year is the default.
      aYear: String(new Date().getFullYear()),
      displayName: client.businessName?.trim() || null,
    });
    if (!saved) throw new Error(`could not remember ${whatsAppNo}`);
    return saved;
  }

  /** The parameters a document endpoint needs, from a resolved client. */
  toDocumentParameters(tenant: TenantContext): Record<string, string> {
    return { companyId: String(tenant.sid), branch: tenant.grp, year: tenant.aYear };
  }

  async list(): Promise<BotUser[]> {
    return this.users.find({ order: { createdAt: 'ASC' } });
  }

  async upsert(input: {
    whatsAppNo: string;
    sid: number;
    grp: string;
    aYear: string;
    displayName?: string | null;
  }): Promise<BotUser | null> {
    const whatsAppNo = normalizeWhatsAppNumber(input.whatsAppNo);
    if (!whatsAppNo) return null;

    const now = new Date();
    const existing = await this.users.findOne({ where: { whatsAppNo } });
    if (existing) {
      Object.assign(existing, { ...input, whatsAppNo, updatedAt: now, isActive: true });
      return this.users.save(existing);
    }
    return this.users.save(
      this.users.create({
        ...input,
        whatsAppNo,
        displayName: input.displayName ?? null,
        isActive: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
  }

  /** Turns a number away without forgetting which company it was ever mapped to. */
  async deactivate(whatsAppNo: string): Promise<boolean> {
    const existing = await this.users.findOne({ where: { whatsAppNo } });
    if (!existing) return false;
    existing.isActive = false;
    existing.updatedAt = new Date();
    await this.users.save(existing);
    return true;
  }

  /**
   * The accounts in a client's chart, from the host.
   *
   * `ActHead=RECEIVABLE` is the only value the host actually filters on — anything else, and
   * an empty value, returns every account. So the filter is applied here as well, on the code
   * prefix, rather than trusting a parameter the host ignores.
   *
   * **The response carries no names**: `lcode`, `telNo` and `email` only. A person saying
   * "Ahmed" cannot be resolved from this, which is why `findByPhone` exists and
   * `findByName` does not.
   */
  async fetchAccounts(tenant: TenantContext, actHead = 'RECEIVABLE'): Promise<BotAccount[]> {
    const base = (process.env.TIJARAH_QUEUE_BASE_URL ?? 'https://api.tijarabooks.com/BotConnectApi').replace(/\/$/, '');
    const url = `${base}/GetBotCustomers?Sid=${encodeURIComponent(String(tenant.sid))}&Grp=${encodeURIComponent(tenant.grp)}&ActHead=${encodeURIComponent(actHead)}`;

    try {
      const res = await request(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        headersTimeout: 30_000,
        bodyTimeout: 30_000,
      });
      if (res.statusCode >= 400) {
        this.logger.warn(`GetBotCustomers responded ${res.statusCode}`);
        return [];
      }
      const body = (await res.body.json()) as { data?: BotAccount[] };
      return Array.isArray(body?.data) ? body.data : [];
    } catch (error) {
      this.logger.warn(`could not read accounts: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Finds an account by the phone number on file.
   *
   * The only identifier in the host's payload that a person would recognise. Matching is on
   * normalised digits, because the host stores them the local way ("0331 3687287") and a
   * message quotes them any way at all.
   *
   * Returns every match rather than the best one. Two accounts sharing a phone number is a
   * question for a human, not a ranking problem — picking one sends somebody the wrong
   * ledger.
   */
  async findByPhone(tenant: TenantContext, phone: string, actHead = 'RECEIVABLE'): Promise<BotAccount[]> {
    const wanted = normalizeWhatsAppNumber(phone);
    if (!wanted) return [];
    const accounts = await this.fetchAccounts(tenant, actHead);
    return accounts.filter(account => normalizeWhatsAppNumber(account.telNo ?? '') === wanted);
  }

  /** Whether a code exists in this client's chart, so a bad one fails before a fetch. */
  async accountExists(tenant: TenantContext, lcode: string, actHead = 'RECEIVABLE'): Promise<boolean> {
    const wanted = lcode.trim().toUpperCase();
    const accounts = await this.fetchAccounts(tenant, actHead);
    return accounts.some(account => account.lcode?.trim().toUpperCase() === wanted);
  }
}

/** `923001234567` → `03001234567`, the form the host's directory stores. */
export function toLocalForm(whatsAppNo: string): string {
  const cc = (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE ?? '92').replace(/\D/g, '');
  return whatsAppNo.startsWith(cc) && whatsAppNo.length > cc.length + 6
    ? `0${whatsAppNo.slice(cc.length)}`
    : whatsAppNo;
}

function isHostClient(row: unknown): row is HostClient {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as Record<string, unknown>;
  return Number.isFinite(Number(r.sid)) && Number(r.sid) > 0 && typeof r.grp === 'string' && r.grp.trim().length > 0;
}
