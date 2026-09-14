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

  /** The company this number belongs to, or null when it is not registered. */
  async resolve(phone: string): Promise<TenantContext | null> {
    const whatsAppNo = normalizeWhatsAppNumber(phone);
    if (!whatsAppNo) return null;

    const user = await this.users.findOne({ where: { whatsAppNo, isActive: true } });
    if (!user) {
      this.logger.warn(`${whatsAppNo} is not registered to a company — refusing rather than guessing one`);
      return null;
    }
    return { whatsAppNo, sid: user.sid, grp: user.grp, aYear: user.aYear, displayName: user.displayName };
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
