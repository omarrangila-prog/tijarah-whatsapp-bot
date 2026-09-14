import { Inject, Injectable, OnApplicationBootstrap, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { StorageService } from '../../common/storage/storage.service';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { DocumentTypeRegistry } from './entities/document-type-registry.entity';
import {
  backoffMs,
  INFRASTRUCTURE_RETRY_MS,
  isInfrastructureFailure,
  isRetryable,
  type JobErrorCode,
  type JobStatus,
} from './job-status';
import { DocumentError } from './providers/document-provider';
import { HttpDocumentProvider } from './providers/http-document.provider';
import { BrowserDocumentProvider } from './providers/browser-document.provider';
import { PuppeteerBrowserSession, readBrowserConfig } from './providers/browser-session';
import type { DocumentProvider } from './providers/document-provider';
import { WHATSAPP_DELIVERY_PROVIDER, type WhatsAppDeliveryProvider } from './providers/whatsapp-delivery.provider';
import { recordJobClaimed, recordJobFailed, recordJobSent } from './job-metrics';

/** Everything the worker's behaviour is tuned by, all of it from the environment. */
export interface WorkerConfig {
  pollIntervalSeconds: number;
  batchSize: number;
  maxAttempts: number;
  leaseSeconds: number;
  documentApiTimeoutSeconds: number;
  sessionId: string;
  enabled: boolean;
  /** How many jobs in a batch may be in flight at once. */
  concurrency: number;
  /** Keep a copy of each delivered document. Off by default: it is customer financial data. */
  retainDocuments: boolean;
}

export function readWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const int = (key: string, fallback: number): number => {
    const parsed = Number.parseInt(env[key] ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return {
    pollIntervalSeconds: int('JOB_POLL_INTERVAL_SECONDS', 5),
    batchSize: int('JOB_BATCH_SIZE', 10),
    maxAttempts: int('JOB_MAX_ATTEMPTS', 3),
    leaseSeconds: int('JOB_PROCESSING_LEASE_SECONDS', 120),
    documentApiTimeoutSeconds: int('DOCUMENT_API_TIMEOUT_SECONDS', 30),
    sessionId: env.WHATSAPP_JOBS_SESSION_ID ?? 'default',
    // Opt-in. A worker that starts itself on every install would begin sending documents from
    // whatever half-configured environment it found itself in.
    enabled: env.WHATSAPP_JOBS_WORKER === 'true',
    concurrency: Math.max(1, int('JOB_CONCURRENCY', 3)),
    retainDocuments: env.WHATSAPP_JOBS_RETAIN_DOCUMENTS === 'true',
  };
}

/**
 * The background worker: claims jobs, fetches documents, sends them, records what happened.
 *
 * It polls rather than using the BullMQ queue in this repo on purpose. Redis is optional here
 * (`QUEUE_ENABLED=false` by default) and §9 asks for durable at-least-once delivery with a
 * recoverable lease — which the jobs table already provides, and which survives Redis being
 * absent, restarted or flushed. The claim is a conditional UPDATE, so correctness does not
 * depend on there being exactly one worker.
 */
@Injectable()
export class JobWorkerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('JobWorker');
  private readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  readonly config: WorkerConfig;

  constructor(
    @InjectRepository(WhatsAppDocumentJob, 'data') private readonly jobs: Repository<WhatsAppDocumentJob>,
    @InjectRepository(DocumentTypeRegistry, 'data') private readonly registry: Repository<DocumentTypeRegistry>,
    @Inject(WHATSAPP_DELIVERY_PROVIDER) private readonly whatsapp: WhatsAppDeliveryProvider,
    @Optional() private readonly storage?: StorageService,
  ) {
    this.config = readWorkerConfig();
  }

  onApplicationBootstrap(): void {
    if (!this.config.enabled) {
      this.logger.log('worker disabled (set WHATSAPP_JOBS_WORKER=true to run it)');
      return;
    }
    this.logger.log(
      `worker ${this.workerId} polling every ${this.config.pollIntervalSeconds}s, batch ${this.config.batchSize}, lease ${this.config.leaseSeconds}s`,
    );
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    // A shared browser outlives individual jobs, so it has to be closed with the module or it
    // keeps a Chrome process (or a remote connection) alive past shutdown.
    void this.browserSession?.close().catch(() => undefined);
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule());
    }, this.config.pollIntervalSeconds * 1000);
    // Never hold the process open just to poll.
    this.timer.unref?.();
  }

  /** One pass: recover abandoned work, promote due retries, then process a batch. */
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      await this.recoverExpiredLeases();
      await this.promoteDueRetries();
      const claimed = await this.claimBatch(this.config.batchSize);
      await this.processAll(claimed);
      return claimed.length;
    } catch (error) {
      this.logger.error(`worker tick failed: ${(error as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  /**
   * Returns work whose holder stopped reporting.
   *
   * A worker that is killed mid-job leaves the row in flight with a lease that then expires.
   * `SENT` is excluded by the status filter and that exclusion is the important part: a job
   * whose document reached the customer just before the crash must never come back here, or
   * the recovery mechanism becomes a duplicate-send mechanism.
   */
  async recoverExpiredLeases(): Promise<number> {
    const result = await this.jobs
      .createQueryBuilder()
      .update(WhatsAppDocumentJob)
      .set({
        status: 'PENDING',
        claimedBy: null,
        claimedAt: null,
        processingLeaseExpiresAt: null,
        updatedAt: new Date(),
      })
      .where('status IN (:...inFlight)', {
        inFlight: ['CLAIMED', 'PROCESSING', 'FETCHING_DOCUMENT', 'DOCUMENT_RECEIVED', 'SENDING_TO_WHATSAPP'],
      })
      .andWhere('processingLeaseExpiresAt IS NOT NULL')
      .andWhere('processingLeaseExpiresAt < :now', { now: new Date().toISOString() })
      .execute();
    const count = result.affected ?? 0;
    if (count) this.logger.warn(`recovered ${count} job(s) from expired leases`);
    return count;
  }

  /** RETRY_SCHEDULED jobs whose backoff has elapsed become PENDING again. */
  async promoteDueRetries(): Promise<number> {
    const result = await this.jobs
      .createQueryBuilder()
      .update(WhatsAppDocumentJob)
      .set({ status: 'PENDING', updatedAt: new Date() })
      .where('status = :status', { status: 'RETRY_SCHEDULED' })
      .andWhere('nextRetryAt IS NOT NULL')
      .andWhere('nextRetryAt <= :now', { now: new Date().toISOString() })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Takes ownership of up to `limit` jobs.
   *
   * The claim is a conditional UPDATE guarded by `status = 'PENDING'`, so two workers racing
   * for the same row produce one winner and one no-op: the loser's UPDATE matches zero rows
   * and it simply moves on. This is why the worker needs no distributed lock and no Redis —
   * the database's own row locking is the mutual exclusion.
   */
  async claimBatch(limit: number): Promise<WhatsAppDocumentJob[]> {
    const candidates = await this.jobs.find({
      where: { status: 'PENDING' as JobStatus },
      order: { priority: 'DESC', createdAt: 'ASC' },
      take: limit,
    });

    const claimed: WhatsAppDocumentJob[] = [];
    const now = new Date();
    for (const candidate of candidates) {
      const result = await this.jobs
        .createQueryBuilder()
        .update(WhatsAppDocumentJob)
        .set({
          status: 'CLAIMED',
          claimedBy: this.workerId,
          claimedAt: now,
          processingLeaseExpiresAt: new Date(now.getTime() + this.config.leaseSeconds * 1000),
          startedAt: candidate.startedAt ?? now,
          attemptCount: candidate.attemptCount + 1,
          updatedAt: now,
        })
        .where('id = :id', { id: candidate.id })
        .andWhere('status = :expected', { expected: 'PENDING' })
        .execute();

      if ((result.affected ?? 0) > 0) {
        const fresh = await this.jobs.findOne({ where: { id: candidate.id } });
        if (fresh) {
          claimed.push(fresh);
          recordJobClaimed();
        }
      }
    }
    return claimed;
  }

  /** Moves a job forward, refusing to write if this worker no longer holds the lease. */
  private async advance(job: WhatsAppDocumentJob, status: JobStatus, detail?: string): Promise<void> {
    const now = new Date();
    job.status = status;
    job.updatedAt = now;
    job.timeline = [...(job.timeline ?? []), { at: now.toISOString(), status, detail: detail ?? null }];
    if (status === 'DOCUMENT_RECEIVED') job.documentReceivedAt = now;
    if (status === 'SENT') {
      job.sentAt = now;
      job.completedAt = now;
    }
    // Extend the lease on every step, so a slow but healthy job is not reclaimed underneath us.
    job.processingLeaseExpiresAt = new Date(now.getTime() + this.config.leaseSeconds * 1000);

    const result = await this.jobs
      .createQueryBuilder()
      .update(WhatsAppDocumentJob)
      .set({
        status: job.status,
        updatedAt: job.updatedAt,
        timeline: job.timeline,
        documentReceivedAt: job.documentReceivedAt,
        sentAt: job.sentAt,
        completedAt: job.completedAt,
        processingLeaseExpiresAt: job.processingLeaseExpiresAt,
        documentUrl: job.documentUrl,
        // Included because the API may name the file (a JSON or URL response carries one), and
        // without this the name derived at fetch time never reached the row.
        documentName: job.documentName,
        documentStorageKey: job.documentStorageKey,
        documentMimeType: job.documentMimeType,
        documentSize: job.documentSize,
        whatsappMessageId: job.whatsappMessageId,
      })
      .where('id = :id', { id: job.id })
      .andWhere('claimedBy = :worker', { worker: this.workerId })
      .execute();

    if ((result.affected ?? 0) === 0) {
      /*
       * Someone else owns this job now — this worker was slow enough that its lease expired
       * and the sweeper handed the job on. Stopping here is what prevents the same document
       * being sent by two workers.
       */
      throw new DocumentError('LEASE_EXPIRED', 'Lease expired; another worker has taken this job');
    }
  }

  /**
   * Works through a claimed batch with a bounded number in flight.
   *
   * Sequentially was wrong in a way that only shows under load: a document API taking its full
   * thirty-second timeout held up the other nine jobs in the batch behind it, so one unwell
   * integration stalled deliveries for every other document type. Unbounded would be wrong
   * too — ten simultaneous document fetches, each up to the size limit, is a memory spike and
   * a thundering herd at whoever's API it is.
   *
   * Each job's own failure is contained by `process`, so one bad job cannot abort the batch.
   */
  private async processAll(jobs: WhatsAppDocumentJob[]): Promise<void> {
    const queue = [...jobs];
    const lanes = Math.min(this.config.concurrency, queue.length);
    const runLane = async (): Promise<void> => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await this.process(job);
      }
    };
    await Promise.all(Array.from({ length: lanes }, () => runLane()));
  }

  /**
   * Picks how this document type's file is obtained.
   *
   * The browser session is created once and shared: launching Chrome per document would turn a
   * five-second job into a twenty-second one and sign in to the host system once per invoice.
   */
  private providerFor(config: DocumentTypeRegistry): DocumentProvider {
    const baseUrl = process.env.DOCUMENT_API_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 2785}`;
    if (config.providerKind === 'browser') {
      this.browserSession ??= new PuppeteerBrowserSession(readBrowserConfig());
      this.browserProvider ??= new BrowserDocumentProvider(baseUrl, this.browserSession);
      return this.browserProvider;
    }
    return new HttpDocumentProvider(baseUrl);
  }

  private browserSession: PuppeteerBrowserSession | null = null;
  private browserProvider: BrowserDocumentProvider | null = null;

  /** The whole pipeline for one job. */
  async process(job: WhatsAppDocumentJob): Promise<void> {
    let storageKey: string | null = null;
    let sentOk = false;
    try {
      await this.advance(job, 'PROCESSING', 'Worker claimed the job');

      const config = await this.registry.findOne({ where: { documentType: job.documentType } });
      if (!config) throw new DocumentError('UNSUPPORTED_DOCUMENT_TYPE', `No registry entry for "${job.documentType}"`);
      if (!config.enabled)
        throw new DocumentError('DOCUMENT_TYPE_DISABLED', `Document type "${job.documentType}" is disabled`);

      const provider = this.providerFor(config);
      provider.validateParameters(job, config);

      /*
       * The recipient is checked BEFORE the document is fetched.
       *
       * Checking afterwards means generating a customer's invoice, holding it in memory and
       * then discovering the number was never on WhatsApp — work done, and a permanent
       * failure reported one stage later than it was knowable. The check is skipped rather
       * than failed when the engine cannot answer, so an unavailable lookup never blocks a
       * delivery that would otherwise have worked.
       */
      const check = await this.whatsapp
        .validateNumber(this.config.sessionId, job.recipientWhatsAppNumber)
        .catch(() => ({ exists: true, chatId: null }));
      if (!check.exists) {
        throw new DocumentError('INVALID_RECIPIENT_NUMBER', `${job.recipientWhatsAppNumber} is not on WhatsApp`);
      }

      /*
       * WhatsApp is checked before the document is fetched, not after.
       *
       * Fetching first meant generating a customer's invoice, holding it in memory, and only
       * then discovering there was nowhere to send it — work done for nothing, and the
       * document briefly resident for no reason. The state was knowable before any of that.
       */
      const preflight = await this.whatsapp.getConnectionStatus(this.config.sessionId);
      if (preflight !== 'CONNECTED') {
        throw new DocumentError('WHATSAPP_DISCONNECTED', `WhatsApp session is ${preflight}`);
      }

      await this.advance(job, 'FETCHING_DOCUMENT', `Calling ${config.method} ${config.endpoint}`);
      const fetchStartedAt = Date.now();
      const request = provider.buildRequest(job, config);
      const raw = await provider.fetchDocument(request, config);
      const parsed = await provider.parseResponse(raw, config);
      provider.validateDocument(parsed, job, config);
      const filename = provider.determineFilename(job, config, parsed);

      job.documentMimeType = parsed.mimeType;
      job.documentSize = parsed.content.length;
      job.documentUrl = parsed.sourceUrl;
      job.documentName = filename;

      /*
       * Keeping a copy is opt-in, and off by default.
       *
       * This used to write the document and then delete it unconditionally in a `finally`,
       * which was the worst of both: the IO of storing a customer's financial document, none
       * of the benefit, and a `documentStorageKey` on every row pointing at a file that no
       * longer existed — a jobs screen showing a path to nothing.
       *
       * With retention on, a successfully sent document is kept so an operator can see what
       * actually went out; a failed one is removed, because a half-delivered invoice sitting
       * in storage is a liability with no reader. With retention off, nothing is written at
       * all — the document goes from the API to WhatsApp and never touches a disk.
       */
      if (this.storage && this.config.retainDocuments) {
        storageKey = `whatsapp-jobs/${job.reference}/${filename}`;
        await this.storage.putFile(storageKey, parsed.content);
        job.documentStorageKey = storageKey;
      }

      const documentReceivedAt = Date.now();
      await this.advance(job, 'DOCUMENT_RECEIVED', `${filename} · ${parsed.content.length} bytes · ${parsed.mimeType}`);

      await this.advance(job, 'SENDING_TO_WHATSAPP', `To ${job.recipientWhatsAppNumber}`);
      const sendStartedAt = Date.now();
      /*
       * Checked again, deliberately — this is not a duplicate of the preflight above.
       *
       * Fetching a document takes real time, and a session can drop during it. The preflight
       * avoids doing that work for nothing; this one avoids handing a document to a transport
       * that has since gone away. Either way the job parks rather than failing.
       */
      const state = await this.whatsapp.getConnectionStatus(this.config.sessionId);
      if (state !== 'CONNECTED') {
        throw new DocumentError('WHATSAPP_DISCONNECTED', `WhatsApp session is ${state}`);
      }

      const delivery = await this.whatsapp.sendDocument(this.config.sessionId, {
        recipientWhatsAppNumber: job.recipientWhatsAppNumber,
        fileDataOrPath: parsed.content.toString('base64'),
        filename,
        caption: job.messageText ?? undefined,
        mimeType: parsed.mimeType,
      });

      job.whatsappMessageId = delivery.messageId;
      await this.advance(
        job,
        'SENT',
        `WhatsApp message ${delivery.messageId}${delivery.mock ? ' (recorded, not transmitted)' : ''}`,
      );
      // Measured over this attempt only, matching how the KPI screen splits the two legs.
      recordJobSent(documentReceivedAt - fetchStartedAt, Date.now() - sendStartedAt);
      this.logger.log(`${job.reference} sent as ${delivery.messageId}`);
      sentOk = true;
    } catch (error) {
      await this.fail(job, error);
    } finally {
      // Only a document that never reached anyone is cleaned up. The row's key is cleared with
      // it, so it can never point at a file that has been removed.
      if (storageKey && this.storage && !sentOk) {
        await this.storage.deleteFile(storageKey).catch(() => undefined);
        await this.jobs.update({ id: job.id }, { documentStorageKey: null }).catch(() => undefined);
      }
    }
  }

  /** Decides between another attempt and giving up, and records why. */
  private async fail(job: WhatsAppDocumentJob, error: unknown): Promise<void> {
    const code: JobErrorCode = error instanceof DocumentError ? error.code : 'UNKNOWN';
    const message = (error as Error).message ?? 'Unknown error';

    if (code === 'LEASE_EXPIRED') {
      // Another worker owns it. Say nothing to the row — writing would be the very race the
      // lease check just prevented.
      this.logger.warn(`${job.reference}: ${message}`);
      return;
    }

    const now = new Date();

    /*
     * An infrastructure failure parks the job instead of charging it an attempt.
     *
     * The attempt is refunded, so a session that is down for an hour costs a queued document
     * nothing: when the number comes back the job is still PENDING its full budget and goes
     * out. Without this, the attempt budget measured how long the outage lasted rather than
     * how many times delivery had genuinely been tried, and every deliverable document in the
     * queue was marked FAILED for something that had nothing to do with it.
     */
    const parked = isInfrastructureFailure(code);
    const attemptsLeft = job.attemptCount < job.maximumAttempts;
    const retry = parked || (attemptsLeft && isRetryable(code));
    const status: JobStatus = retry ? 'RETRY_SCHEDULED' : 'FAILED';
    const nextRetryAt = retry
      ? new Date(now.getTime() + (parked ? INFRASTRUCTURE_RETRY_MS : backoffMs(job.attemptCount)))
      : null;

    await this.jobs
      .createQueryBuilder()
      .update(WhatsAppDocumentJob)
      .set({
        status,
        // Refunded for a parked job: waiting on a reconnection is not an attempt at delivery.
        attemptCount: parked ? Math.max(0, job.attemptCount - 1) : job.attemptCount,
        errorCode: code,
        // Truncated and never a stack trace: this string is shown to operators.
        errorMessage: message.slice(0, 480),
        nextRetryAt,
        completedAt: retry ? null : now,
        claimedBy: null,
        claimedAt: null,
        processingLeaseExpiresAt: null,
        updatedAt: now,
        timeline: [
          ...(job.timeline ?? []),
          {
            at: now.toISOString(),
            status,
            detail: parked
              ? `${code}: ${message.slice(0, 200)} — waiting for the connection, no attempt used`
              : retry
                ? `${code}: ${message.slice(0, 200)} — retry ${job.attemptCount + 1}/${job.maximumAttempts} at ${nextRetryAt?.toISOString()}`
                : `${code}: ${message.slice(0, 200)}`,
          },
        ],
      })
      .where('id = :id', { id: job.id })
      .andWhere('claimedBy = :worker', { worker: this.workerId })
      .execute();

    recordJobFailed(code, retry);
    this.logger[retry ? 'warn' : 'error'](`${job.reference} ${status}: ${code} — ${message.slice(0, 200)}`);
  }
}
