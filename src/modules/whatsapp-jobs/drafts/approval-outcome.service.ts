import { Injectable, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { request } from 'undici';
import { createLogger } from '../../../common/services/logger.service';
import { BotUserService, type TenantContext } from '../tenancy/bot-user.service';
import { WhatsAppJobsService } from '../whatsapp-jobs.service';
import { buildCaption } from '../caption';
import { DocumentDraft } from './document-draft.entity';

/**
 * The far side of Phase Three.
 *
 * A draft submitted from WhatsApp sits on Tijarah's approval screen until a person there
 * accepts or rejects it. `GetActiveRequest` is how the host reports that decision back, and
 * this service is the only thing that reads it: it polls for each draft still waiting, and
 * when one is accepted it queues the finished document for delivery to whoever composed it.
 *
 * Nothing here approves anything. The decision is made by a human inside Tijarah Books; this
 * only notices that it happened and closes the loop.
 */

/** What the host calls a decision. Matched case-insensitively, because casing has varied. */
const ACCEPTED = ['APPROVED', 'ACCEPTED', 'COMPLETED', 'POSTED', 'DONE'];
const REFUSED = ['REJECTED', 'DECLINED', 'CANCELLED', 'CANCELED', 'FAILED', 'FAIL'];

/**
 * Where a document number hides in the host's answer.
 *
 * Several spellings because the accepted payload was not available when this was written — the
 * PENDING one carries none of these. An accepted request whose number matches none of them is
 * logged **in full** rather than guessed at, so the first real approval either works or says
 * exactly what it sent instead.
 */
const NUMBER_KEYS = ['documentNo', 'documentNumber', 'docNo', 'voucherNo', 'invoiceNo', 'invoiceId', 'refNo', 'number'];

export interface ActiveRequest {
  id: number | string;
  whatsAppNo: string;
  sid: number;
  grp: string;
  aYear: string;
  requestType: string;
  requestStatus: string;
  requestData?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface ApprovalOutcomeConfig {
  enabled: boolean;
  baseUrl: string;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
}

export function readApprovalOutcomeConfig(env: NodeJS.ProcessEnv = process.env): ApprovalOutcomeConfig {
  const poll = Number.parseInt(env.APPROVAL_POLL_SECONDS ?? '', 10);
  const timeout = Number.parseInt(env.APPROVAL_POLL_TIMEOUT_SECONDS ?? '', 10);
  const submit = env.DRAFT_SUBMIT_ENDPOINT?.trim() ?? '';
  return {
    // Follow-up only makes sense where drafts are actually submitted to a host.
    enabled: env.APPROVAL_POLL_ENABLED === 'true' && /UpsertRequest/i.test(submit),
    // Derived from the submit endpoint, so the two halves cannot be pointed at different hosts.
    baseUrl: submit.replace(/\/UpsertRequest\/?$/i, ''),
    pollIntervalSeconds: Number.isFinite(poll) && poll > 0 ? poll : 30,
    timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : 30,
  };
}

/** The deliverable document behind a create request, or null where there is no PDF. */
export function deliverableTypeFor(draftDocumentType: string): string | null {
  const type = draftDocumentType.replace(/^create_/, '');
  /*
   * A party or an item has no document to send.
   *
   * Creating a customer account produces a row in a chart of accounts, not a PDF, so an
   * approved one is reported to the person and nothing is fetched. The five account types and
   * the item type all end in `_account`, which is what distinguishes them.
   */
  return type === draftDocumentType || type.endsWith('_account') ? null : type;
}

@Injectable()
export class ApprovalOutcomeService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('ApprovalOutcome');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  readonly config: ApprovalOutcomeConfig;

  constructor(
    @InjectRepository(DocumentDraft, 'data') private readonly drafts: Repository<DocumentDraft>,
    private readonly users: BotUserService,
    private readonly jobs: WhatsAppJobsService,
  ) {
    this.config = readApprovalOutcomeConfig();
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('approval follow-up disabled (set APPROVAL_POLL_ENABLED=true)');
      return;
    }
    this.logger.log(`following up approvals at ${this.config.baseUrl} every ${this.config.pollIntervalSeconds}s`);
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.config.pollIntervalSeconds * 1000);
    this.timer.unref?.();
  }

  /** One pass over every draft still waiting on a decision. */
  async tick(): Promise<{ checked: number; accepted: number; refused: number }> {
    if (this.running) return { checked: 0, accepted: 0, refused: 0 };
    this.running = true;
    try {
      const waiting = (await this.drafts.find({ where: { status: 'SUBMITTED' } })).filter(isHostSubmitted);
      let accepted = 0;
      let refused = 0;
      for (const draft of waiting) {
        const outcome = await this.follow(draft).catch(error => {
          this.logger.warn(`${draft.reference}: ${(error as Error).message}`);
          return null;
        });
        if (outcome === 'accepted') accepted += 1;
        if (outcome === 'refused') refused += 1;
      }
      return { checked: waiting.length, accepted, refused };
    } finally {
      this.running = false;
    }
  }

  /** Checks one draft, and acts if the decision has been made. */
  async follow(draft: DocumentDraft): Promise<'waiting' | 'accepted' | 'refused' | null> {
    const tenant = await this.users.resolve(draft.createdByPhone);
    if (!tenant) return null;

    const rows = await this.fetchRequests(tenant, draft.createdByPhone);
    if (rows.length === 0) return 'waiting';

    /*
     * Our own row, by the host's id.
     *
     * With a list, the draft's request is looked up directly and a row for a different request
     * is simply not ours — no warning, no guessing. With today's single row, the one row is
     * examined the same way, so an older draft correctly sees "not mine" and keeps waiting.
     */
    const active = rows.find(row => draft.submittedRef !== null && String(row.id) === draft.submittedRef) ?? rows[0];

    /*
     * The host's own filter is not trusted.
     *
     * `whatsAppNo=0` came back with a request belonging to a different number, so the answer is
     * checked against what was asked for. Acting on an unverified row would send one person the
     * document another person composed — the exact failure this whole tenancy layer exists to
     * prevent.
     */
    const match = this.match(active, tenant, draft);
    if (match !== 'mine') {
      /*
       * A different request is the ordinary case and not worth a warning: `GetActiveRequest`
       * returns one row per company, so several people composing at once means most polls see
       * somebody else's. A different *number or company* on a row we asked about by number is
       * not ordinary, and is the thing worth shouting about.
       */
      const message = `${draft.reference}: host returned request ${String(active.id)} for ${String(active.whatsAppNo)}/${String(active.sid)} — ignored`;
      if (match === 'someone-else') this.logger.warn(message);
      else this.logger.debug?.(message);
      return null;
    }

    const status = String(active.requestStatus ?? '').toUpperCase();
    if (ACCEPTED.includes(status)) return (await this.deliver(draft, tenant, active)) ? 'accepted' : null;
    if (REFUSED.includes(status)) {
      draft.status = 'REJECTED';
      draft.updatedAt = new Date();
      await this.drafts.save(draft);
      this.logger.log(`${draft.reference} was rejected on the approval screen`);
      return 'refused';
    }
    return 'waiting';
  }

  /** Whether this row is the one we asked about, somebody else's, or a different request. */
  private match(
    active: ActiveRequest,
    tenant: TenantContext,
    draft: DocumentDraft,
  ): 'mine' | 'other-request' | 'someone-else' {
    const sameNumber = String(active.whatsAppNo ?? '').replace(/\D/g, '') === draft.createdByPhone.replace(/\D/g, '');
    const sameCompany = Number(active.sid) === tenant.sid && String(active.grp) === tenant.grp;
    if (!sameNumber || !sameCompany) return 'someone-else';
    return !draft.submittedRef || String(active.id) === draft.submittedRef ? 'mine' : 'other-request';
  }

  /**
   * Every request the host will tell us about, for one number.
   *
   * Today `data` is a single object — the most recent active request — and a draft that is not
   * the most recent can never be followed. The host is changing this to return every request
   * (approved, pending, failed) as a list; both shapes are read here so the day it changes,
   * nothing has to be redeployed. A row is matched on the host's own id, never on position.
   */
  private async fetchRequests(tenant: TenantContext, whatsAppNo: string): Promise<ActiveRequest[]> {
    const url =
      `${this.config.baseUrl}/GetActiveRequest?sid=${encodeURIComponent(String(tenant.sid))}` +
      `&grp=${encodeURIComponent(tenant.grp)}&aYear=${encodeURIComponent(tenant.aYear)}` +
      `&whatsAppNo=${encodeURIComponent(whatsAppNo)}`;
    const timeoutMs = this.config.timeoutSeconds * 1000;
    const res = await request(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    if (res.statusCode >= 400) throw new Error(`GetActiveRequest responded ${res.statusCode}`);
    const body = (await res.body.json()) as { hasActiveRequest?: boolean; data?: unknown };
    return readRequests(body?.data);
  }

  /**
   * Queues the approved document for delivery to whoever composed it.
   *
   * Idempotent on the host's request id, so a row that stays "approved" across several polls
   * produces one delivery rather than one per pass.
   */
  private async deliver(draft: DocumentDraft, tenant: TenantContext, active: ActiveRequest): Promise<boolean> {
    const documentType = deliverableTypeFor(draft.documentType);
    const documentNumber = findDocumentNumber(active);

    if (!documentType) {
      // A customer or item account: approved, but there is nothing to send.
      this.logger.log(`${draft.reference} approved — ${draft.displayName} has no document to deliver`);
      await this.close(draft);
      return true;
    }
    if (!documentNumber) {
      /*
       * Approved, but the host did not say which document it became.
       *
       * Logged whole rather than guessed: fetching `.../{year}/undefined` would return
       * something, and whatever came back would be sent to a customer as their invoice.
       */
      this.logger.warn(
        `${draft.reference} approved but no document number found in the host's answer: ${JSON.stringify(active)}`,
      );
      return false;
    }

    const idempotencyKey = `tijarah-approval-${String(active.id)}`;
    const caption = buildCaption(documentType, {
      displayName: draft.displayName,
      documentNumber,
      reference: documentNumber,
      recipientName: draft.fields?.partyName ?? null,
    });

    try {
      const job = await this.jobs.create({
        source: 'module',
        documentType,
        documentReference: documentNumber,
        recipientWhatsAppNumber: draft.createdByPhone,
        messageText: caption,
        parameters: {
          companyId: String(tenant.sid),
          branch: tenant.grp,
          year: tenant.aYear,
          documentNumber,
        },
        idempotencyKey,
      });
      this.logger.log(`${draft.reference} approved as ${documentType} ${documentNumber} → ${job.reference}`);
    } catch (error) {
      const message = (error as Error).message;
      // A duplicate key means a previous pass already queued it, which is the desired end state.
      if (!/duplicate|idempotenc/i.test(message)) throw error;
    }

    await this.close(draft);
    return true;
  }

  /** Marks the draft decided, so it stops being polled. */
  private async close(draft: DocumentDraft): Promise<void> {
    await this.drafts.update({ id: draft.id }, { status: 'APPROVED', updatedAt: new Date() });
  }
}

/** Digs the host's document number out of wherever it put it. */
export function findDocumentNumber(active: ActiveRequest): string | null {
  const scopes: Record<string, unknown>[] = [active, (active.requestData as Record<string, unknown>) ?? {}];
  for (const scope of scopes) {
    for (const key of NUMBER_KEYS) {
      const value = scope[key];
      if (typeof value === 'number' && Number.isFinite(value)) return String(value);
      if (typeof value === 'string' && value.trim() && value.trim().toUpperCase() !== 'NEW') return value.trim();
    }
  }
  return null;
}

/**
 * Whether a draft was submitted to a real host at all.
 *
 * A draft recorded by the mock adapter carries a `mock.approval.` reference and will never
 * appear on anybody's approval screen. Polling for it would question the host forever about a
 * request that does not exist there, once per draft per pass.
 */
export function isHostSubmitted(draft: DocumentDraft): boolean {
  return !draft.submittedRef?.startsWith('mock.approval.');
}

/**
 * `data` as one row or many, read as a list either way.
 *
 * Anything that is not a request-shaped object is dropped rather than passed on: a string, a
 * null, or a wrapper we do not recognise must not reach the matcher as "a row with no number
 * and no company", because that fails every check and only wastes a warning.
 */
export function readRequests(data: unknown): ActiveRequest[] {
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  return rows.filter(
    (row): row is ActiveRequest => typeof row === 'object' && row !== null && 'id' in row && 'requestStatus' in row,
  );
}
