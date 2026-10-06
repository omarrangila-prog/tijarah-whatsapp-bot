import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { request } from 'undici';
import { createLogger } from '../../common/services/logger.service';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { WhatsAppJobsService } from './whatsapp-jobs.service';
import { normalizeWhatsAppNumber } from './providers/whatsapp-delivery.provider';
import { buildCaption } from './caption';

/** One row as the host hands it out. Everything is treated as untrusted input. */
interface PendingBotInvoice {
  id: number | string;
  sid?: number | string;
  grp?: string;
  ayear?: string;
  type?: string;
  invoiceId?: string | number;
  contactName?: string;
  contactNumber?: string;
  fullquery?: string;
}

/**
 * The host's own document codes, mapped to registry document types.
 *
 * `type` arrives as the same short code that appears in the URL path, so the mapping is the
 * one place that knows "SL" means a sale invoice. An unrecognised code is skipped and logged
 * rather than guessed at — sending a customer the wrong kind of document is worse than
 * sending nothing and telling an operator why.
 */
const TYPE_MAP: Readonly<Record<string, string>> = {
  DINV: 'digital_invoice',
  SL: 'sale_invoice',
  PR: 'purchase_invoice',
  SR: 'sale_return',
  RP: 'purchase_return',
  CV: 'payment_voucher',
  DV: 'receive_voucher',
  GL: 'general_ledger',
  CUSTOMER: 'customer_ledger',
  VENDOR: 'vendor_ledger',
  EXPENSE: 'expense_ledger',
};

export const TIJARAH_SOURCE = 'tijarah';

export interface TijarahQueueConfig {
  enabled: boolean;
  baseUrl: string;
  pollIntervalSeconds: number;
  timeoutSeconds: number;
}

export function readTijarahQueueConfig(env: NodeJS.ProcessEnv = process.env): TijarahQueueConfig {
  const poll = Number.parseInt(env.TIJARAH_QUEUE_POLL_SECONDS ?? '', 10);
  const timeout = Number.parseInt(env.TIJARAH_QUEUE_TIMEOUT_SECONDS ?? '', 10);
  return {
    // Opt-in: a deployment that has not been pointed at a host queue must not start polling one.
    enabled: env.TIJARAH_QUEUE_ENABLED === 'true',
    baseUrl: (env.TIJARAH_QUEUE_BASE_URL ?? 'https://api.tijarabooks.com/BotConnectApi').replace(/\/$/, ''),
    pollIntervalSeconds: Number.isFinite(poll) && poll > 0 ? poll : 15,
    timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : 30,
  };
}

/**
 * Brings work in from Tijarah Books, and tells it when the work is done.
 *
 * Two endpoints: `GetPendingBotInvoices` lists what is waiting, `MarkInvoiceProcessed`
 * acknowledges one so it stops being handed out. This service does both halves, and keeps
 * them strictly apart:
 *
 *   1. **Import.** Every pending row becomes a local job, keyed on the host's queue id. The
 *      worker then owns it — fetching the document, sending it, retrying, giving up.
 *   2. **Acknowledge.** Only a job that reached SENT is marked processed.
 *
 * Marking on pickup instead of on delivery would be the serious mistake available here: the
 * host would stop offering the row, and a document that failed to send would be lost with
 * nobody aware of it. Acknowledging after delivery risks the opposite — the host offering a
 * row we already sent — and that is handled by the idempotency key, which is the queue id, so
 * a re-offered row finds its existing job instead of creating a second delivery.
 */
@Injectable()
export class TijarahQueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('TijarahQueue');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  readonly config: TijarahQueueConfig;

  constructor(
    @InjectRepository(WhatsAppDocumentJob, 'data') private readonly jobs: Repository<WhatsAppDocumentJob>,
    private readonly service: WhatsAppJobsService,
  ) {
    this.config = readTijarahQueueConfig();
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('host queue polling disabled (set TIJARAH_QUEUE_ENABLED=true)');
      return;
    }
    this.logger.log(`polling ${this.config.baseUrl} every ${this.config.pollIntervalSeconds}s`);
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

  /** One pass: import what is waiting, then acknowledge what has been delivered. */
  async tick(): Promise<{ imported: number; acknowledged: number }> {
    if (this.running) return { imported: 0, acknowledged: 0 };
    this.running = true;
    try {
      const imported = await this.importPending();
      const acknowledged = await this.acknowledgeDelivered();
      return { imported, acknowledged };
    } catch (error) {
      this.logger.error(`queue pass failed: ${(error as Error).message}`);
      return { imported: 0, acknowledged: 0 };
    } finally {
      this.running = false;
    }
  }

  private async fetchPending(): Promise<PendingBotInvoice[]> {
    const timeoutMs = this.config.timeoutSeconds * 1000;
    const res = await request(`${this.config.baseUrl}/GetPendingBotInvoices`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    if (res.statusCode >= 400) throw new Error(`GetPendingBotInvoices responded ${res.statusCode}`);
    const body = (await res.body.json()) as { data?: unknown };
    return Array.isArray(body?.data) ? (body.data as PendingBotInvoice[]) : [];
  }

  async importPending(): Promise<number> {
    const rows = await this.fetchPending();
    let created = 0;

    for (const row of rows) {
      const queueId = String(row.id ?? '').trim();
      if (!queueId) continue;

      const documentType = TYPE_MAP[String(row.type ?? '').toUpperCase()];
      if (!documentType) {
        this.logger.warn(`queue row ${queueId}: unknown document type "${String(row.type)}" — skipped`);
        continue;
      }

      const recipient = normalizeWhatsAppNumber(row.contactNumber);
      if (!recipient) {
        this.logger.warn(`queue row ${queueId}: unusable contact number — skipped`);
        continue;
      }

      /*
       * Keyed on the host's queue id, not on the document reference.
       *
       * The host legitimately queues the same invoice more than once — two rows for
       * SL/1006/GR/2026/103 were waiting the first time this ran — and each is a request to
       * send it again. Keying on the invoice would refuse the second as a duplicate; keying on
       * the queue id makes a re-offered row find its own job and a genuinely new request
       * create one.
       */
      const idempotencyKey = `${TIJARAH_SOURCE}-queue-${queueId}`;
      const existing = await this.jobs.findOne({ where: { idempotencyKey } });
      if (existing) {
        await this.redeliverIfOnlyRecorded(existing);
        continue;
      }

      const isLedger = documentType.endsWith('_ledger');
      const parameters: Record<string, unknown> = {
        companyId: String(row.sid ?? '1006'),
        branch: String(row.grp ?? 'GR'),
        year: String(row.ayear ?? new Date().getFullYear()),
      };
      if (!isLedger) parameters.documentNumber = String(row.invoiceId ?? '');

      try {
        /*
         * The caption names the document, and nothing else.
         *
         * What a customer reads above a PDF is the business speaking to them, so it carries no
         * mention of a bot, a delivery system or anything else internal. `displayName` comes
         * from the registry, so it reads the way the business names its own documents.
         */
        const config = (await this.service.listDocumentTypes(true)).find(t => t.documentType === documentType);
        const documentReference = String(row.fullquery ?? row.invoiceId ?? queueId);
        const caption = buildCaption(
          documentType,
          {
            displayName: config?.displayName ?? documentType,
            documentNumber: row.invoiceId ? String(row.invoiceId) : null,
            reference: documentReference,
            recipientName: row.contactName?.trim() || null,
          },
          config?.captionTemplate,
        );

        const job = await this.service.create({
          source: 'module',
          documentType,
          documentReference,
          recipientName: row.contactName?.trim() || null,
          recipientWhatsAppNumber: recipient,
          messageText: caption,
          parameters,
          idempotencyKey,
        } as never);

        await this.jobs.update({ id: job.id }, { sourceSystem: TIJARAH_SOURCE, sourceRef: queueId });
        created += 1;
        this.logger.log(`queue row ${queueId} → ${job.reference} (${documentType} for ${recipient})`);
      } catch (error) {
        // A refusal here is the host's data, not our bug — log it and leave the row for a human.
        this.logger.warn(`queue row ${queueId}: ${(error as Error).message}`);
      }
    }
    return created;
  }

  /**
   * Gives a job that was only *recorded* a real delivery, once real delivery is on.
   *
   * In demonstration mode the transport stamps a `mock.` id and transmits nothing, and
   * `acknowledgeDelivered` rightly refuses to tell the host about it — so the host keeps offering
   * the row. But the row's idempotency key already has a job, so the import skipped it, and the
   * job sat at SENT. Switching demonstration mode off then delivered nothing: the first real
   * deployment had four of Tijarah's invoices stuck exactly like that.
   *
   * SENT is otherwise never re-queued (job-status.ts) because a sent document cannot be unsent.
   * A `mock.` send never reached a phone, so re-queuing it keeps that rule's intent. Only rows the
   * host is still offering reach this — the call site is the import of a still-pending row — and
   * only while the real transport is selected, so a demonstration instance never re-sends.
   */
  private async redeliverIfOnlyRecorded(job: WhatsAppDocumentJob): Promise<boolean> {
    const realDelivery = process.env.WHATSAPP_JOBS_MOCK === 'false';
    const onlyRecorded = job.status === 'SENT' && (job.whatsappMessageId ?? '').startsWith('mock.');
    if (!realDelivery || !onlyRecorded || job.sourceAckAt) return false;

    const now = new Date();
    await this.jobs.update(
      { id: job.id, status: 'SENT' },
      {
        status: 'PENDING',
        whatsappMessageId: null,
        sentAt: null,
        completedAt: null,
        attemptCount: 0,
        nextRetryAt: null,
        errorCode: null,
        errorMessage: null,
        claimedBy: null,
        claimedAt: null,
        processingLeaseExpiresAt: null,
        updatedAt: now,
        timeline: [
          ...(job.timeline ?? []),
          {
            at: now.toISOString(),
            status: 'PENDING',
            detail: 'Re-queued: it was only recorded in demonstration mode, and real delivery is now on',
          },
        ],
      },
    );
    this.logger.log(`${job.reference} was only recorded in demonstration mode — re-queued for real delivery`);
    return true;
  }

  /** Tells the host about every delivered job it has not yet been told about. */
  async acknowledgeDelivered(): Promise<number> {
    const delivered = await this.jobs.find({
      where: { sourceSystem: TIJARAH_SOURCE, status: 'SENT', sourceRef: Not(IsNull()), sourceAckAt: IsNull() },
      take: 25,
    });

    let acknowledged = 0;
    for (const job of delivered) {
      /*
       * A recorded send is not a delivery.
       *
       * In demonstration mode the transport stamps every id `mock.` and transmits nothing.
       * Acknowledging one of those would tell Tijarah Books the document had reached the
       * customer — it stops offering the row, and the invoice is lost with nobody aware of it.
       * The prefix is the only reliable signal, and it is checked here rather than left to
       * whoever remembers which mode the instance is in.
       */
      if (job.whatsappMessageId?.startsWith('mock.')) {
        this.logger.warn(
          `${job.reference} was recorded, not transmitted — not acknowledging queue ${job.sourceRef} to the host`,
        );
        continue;
      }
      try {
        await this.markProcessed(job.sourceRef as string);
        await this.jobs.update({ id: job.id }, { sourceAckAt: new Date() });
        acknowledged += 1;
      } catch (error) {
        /*
         * Left unacknowledged so the next pass tries again. The document has already been
         * delivered, so the only cost of a failed acknowledgement is the host offering the row
         * again — which the idempotency key turns into a no-op rather than a second send.
         */
        this.logger.warn(
          `could not acknowledge ${job.reference} (queue ${job.sourceRef}): ${(error as Error).message}`,
        );
      }
    }
    return acknowledged;
  }

  async markProcessed(queueId: string): Promise<void> {
    const timeoutMs = this.config.timeoutSeconds * 1000;
    const res = await request(`${this.config.baseUrl}/MarkInvoiceProcessed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ID: Number(queueId) }),
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
    if (res.statusCode >= 400) {
      const detail = await res.body.text().catch(() => '');
      throw new Error(`MarkInvoiceProcessed responded ${res.statusCode}: ${detail.slice(0, 120)}`);
    }
  }
}
