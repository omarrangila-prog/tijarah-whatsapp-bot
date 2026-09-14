import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { DocumentTypeRegistry } from './entities/document-type-registry.entity';
import { TERMINAL_STATUSES, type JobStatus } from './job-status';
import { normalizeWhatsAppNumber } from './providers/whatsapp-delivery.provider';
import { asScalar, isBlank } from './providers/document-provider';
import { buildCaption } from './caption';
import { recordDuplicatePrevented } from './job-metrics';
import type { CreateWhatsAppDocumentJobDto } from './dto/create-job.dto';

/**
 * Creating, reading and hand-steering jobs.
 *
 * Everything that changes a job outside the worker lives here, and all of it is careful about
 * one thing: a job that has already been SENT is finished. Retry refuses it, the sweeper
 * refuses it, and cancel refuses it — because the only thing those could achieve is sending a
 * customer the same document twice.
 */
@Injectable()
export class WhatsAppJobsService {
  private readonly logger = createLogger('WhatsAppJobsService');

  constructor(
    @InjectRepository(WhatsAppDocumentJob, 'data') private readonly jobs: Repository<WhatsAppDocumentJob>,
    @InjectRepository(DocumentTypeRegistry, 'data') private readonly registry: Repository<DocumentTypeRegistry>,
  ) {}

  /**
   * Sequential, human-quotable references: JOB-1001.
   *
   * Derived from the row count rather than a sequence object so it works identically on both
   * dialects. A collision is impossible in practice and harmless if it happened — the unique
   * constraint is on `reference`, so the insert would fail loudly rather than merge two jobs.
   */
  private async nextReference(): Promise<string> {
    const count = await this.jobs.count();
    return `JOB-${1001 + count}`;
  }

  /** Reports an authorised person may ask for in a conversation. Never customer documents. */
  async listChatRequestable(): Promise<DocumentTypeRegistry[]> {
    return this.registry.find({ where: { enabled: true, chatRequestable: true }, order: { displayName: 'ASC' } });
  }

  async listDocumentTypes(includeDisabled = false): Promise<DocumentTypeRegistry[]> {
    const where = includeDisabled ? {} : { enabled: true };
    return this.registry.find({ where, order: { displayName: 'ASC' } });
  }

  async create(dto: CreateWhatsAppDocumentJobDto): Promise<WhatsAppDocumentJob> {
    /* --- the document type must exist and be switched on --- */
    const config = await this.registry.findOne({ where: { documentType: dto.documentType } });
    if (!config) {
      throw new BadRequestException(`Unsupported document type "${dto.documentType}".`);
    }
    if (!config.enabled) {
      throw new BadRequestException(`Document type "${dto.documentType}" is currently disabled.`);
    }
    /*
     * A type whose endpoint has not been supplied is refused even if someone enables it.
     *
     * The sentinel is there because a plausible-looking guess would be fetched, return the
     * wrong report or an HTML page, and only be noticed once a customer had it. Enabling a row
     * is a one-line UPDATE, so the guard belongs where the work is attempted, not in the seed.
     */
    if (config.endpoint.startsWith('TODO://')) {
      throw new BadRequestException(
        `Document type "${dto.documentType}" has no endpoint configured yet, so it cannot be sent.`,
      );
    }

    /* --- the recipient must be a usable number --- */
    const recipient = normalizeWhatsAppNumber(dto.recipientWhatsAppNumber);
    if (!recipient) {
      throw new BadRequestException('recipientWhatsAppNumber must include the country code and contain 8–15 digits.');
    }

    /* --- every parameter the API needs must be present, checked now rather than at send --- */
    const parameters = dto.parameters ?? {};
    // Checked against the defaults merged in, exactly as the worker will resolve them —
    // otherwise creation rejects jobs that would have run perfectly well.
    const resolved = { ...(config.defaultParameters ?? {}), ...parameters };
    const missing = (config.requiredParameters ?? []).filter(key => isBlank(resolved[key]));
    if (missing.length) {
      throw new BadRequestException(
        `Document type "${dto.documentType}" requires parameter(s): ${missing.join(', ')}.`,
      );
    }

    /*
     * Idempotency is enforced by the unique index, not by this lookup.
     *
     * The lookup exists to return the ORIGINAL job with a clear message, which is what a
     * caller retrying a timed-out request actually wants. The index is what makes it correct
     * when two identical requests arrive at the same instant and both pass the lookup.
     */
    const existing = await this.jobs.findOne({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existing) {
      await this.countDuplicate(dto.documentType);
      throw new ConflictException({
        success: false,
        message: 'A job with this idempotencyKey already exists; no duplicate was created.',
        jobId: existing.reference,
        status: existing.status,
      });
    }

    /*
     * A caption is composed here when the caller did not write one.
     *
     * Doing it per-entry-point left a gap: a job created through the REST API or the
     * dashboard button went out as a bare PDF with no word about what it was, which for a
     * document about someone's money reads as spam. This is the one place every path passes
     * through, so every recipient gets a proper note whatever queued the job.
     */
    const messageText =
      dto.messageText?.trim() ||
      buildCaption(
        config.documentType,
        {
          displayName: config.displayName,
          documentNumber: asScalar(resolved.documentNumber),
          reference: dto.documentReference ?? null,
          recipientName: dto.recipientName ?? null,
          from: asScalar(resolved.from),
          to: asScalar(resolved.to),
        },
        config.captionTemplate,
      );

    const now = new Date();
    const job = this.jobs.create({
      reference: await this.nextReference(),
      source: dto.source,
      requestedByUserId: dto.requestedByUserId ?? null,
      documentType: dto.documentType,
      documentName: dto.documentName ?? null,
      documentReference: dto.documentReference ?? null,
      clientId: dto.clientId ?? null,
      partyId: dto.partyId ?? null,
      recipientName: dto.recipientName ?? null,
      recipientWhatsAppNumber: recipient,
      messageText,
      parametersJson: parameters,
      priority: dto.priority ?? 0,
      status: 'PENDING',
      idempotencyKey: dto.idempotencyKey,
      attemptCount: 0,
      maximumAttempts: config.maximumAttempts,
      timeline: [{ at: now.toISOString(), status: 'PENDING', detail: `Job created from ${dto.source}` }],
      createdAt: now,
      updatedAt: now,
    });

    try {
      return await this.jobs.save(job);
    } catch (error) {
      // The index caught a race the lookup could not. Same answer as the lookup path.
      if (/unique|duplicate/i.test((error as Error).message)) {
        await this.countDuplicate(dto.documentType);
        const winner = await this.jobs.findOne({ where: { idempotencyKey: dto.idempotencyKey } });
        throw new ConflictException({
          success: false,
          message: 'A job with this idempotencyKey already exists; no duplicate was created.',
          jobId: winner?.reference ?? null,
          status: winner?.status ?? null,
        });
      }
      throw error;
    }
  }

  /** Records that the idempotency guard turned a request away. Never fails the request. */
  private async countDuplicate(documentType: string): Promise<void> {
    recordDuplicatePrevented();
    await this.registry
      .createQueryBuilder()
      .update(DocumentTypeRegistry)
      .set({ duplicatesPrevented: () => '"duplicatesPrevented" + 1' })
      .where('documentType = :documentType', { documentType })
      .execute()
      .catch(() => undefined);
  }

  async findByReference(reference: string): Promise<WhatsAppDocumentJob> {
    const job = await this.jobs.findOne({ where: [{ reference }, { id: reference }] });
    if (!job) throw new NotFoundException(`No job ${reference}`);
    return job;
  }

  async list(filter: {
    status?: JobStatus;
    documentType?: string;
    clientId?: string;
    limit?: number;
  }): Promise<WhatsAppDocumentJob[]> {
    const where: Record<string, unknown> = {};
    if (filter.status) where.status = filter.status;
    if (filter.documentType) where.documentType = filter.documentType;
    if (filter.clientId) where.clientId = filter.clientId;
    return this.jobs.find({
      where,
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(Number(filter.limit) || 50, 1), 200),
    });
  }

  /**
   * Puts a failed job back in the queue.
   *
   * Refuses anything that is not FAILED. Retrying a SENT job would send the document twice;
   * retrying one already in flight would produce two workers holding the same job, which the
   * lease exists to prevent. The attempt budget is topped up, because a person asking for a
   * retry is new information — they have presumably fixed whatever failed.
   */
  async retry(reference: string): Promise<WhatsAppDocumentJob> {
    const job = await this.findByReference(reference);
    if (job.status === 'SENT') {
      throw new ConflictException('This job has already been sent; it cannot be sent again.');
    }
    if (job.status !== 'FAILED' && job.status !== 'CANCELLED') {
      throw new ConflictException(`Only a FAILED or CANCELLED job can be retried (this one is ${job.status}).`);
    }
    const now = new Date();
    job.status = 'PENDING';
    job.errorCode = null;
    job.errorMessage = null;
    job.nextRetryAt = null;
    job.claimedBy = null;
    job.claimedAt = null;
    job.processingLeaseExpiresAt = null;
    job.maximumAttempts = job.attemptCount + Math.max(1, job.maximumAttempts);
    job.timeline = [
      ...(job.timeline ?? []),
      { at: now.toISOString(), status: 'PENDING', detail: 'Retry requested by an operator' },
    ];
    job.updatedAt = now;
    return this.jobs.save(job);
  }

  async cancel(reference: string): Promise<WhatsAppDocumentJob> {
    const job = await this.findByReference(reference);
    if (job.status === 'SENT') {
      throw new ConflictException('This job has already been sent; it cannot be cancelled.');
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      throw new ConflictException(`Job is already ${job.status}.`);
    }
    const now = new Date();
    job.status = 'CANCELLED';
    job.completedAt = now;
    job.updatedAt = now;
    job.timeline = [
      ...(job.timeline ?? []),
      { at: now.toISOString(), status: 'CANCELLED', detail: 'Cancelled by an operator' },
    ];
    return this.jobs.save(job);
  }

  /** Counts for the connection screen in §11. */
  async counts(): Promise<{ pending: number; failed: number; sent: number }> {
    const [pending, failed, sent] = await Promise.all([
      this.jobs.count({
        where: {
          status: In([
            'PENDING',
            'CLAIMED',
            'PROCESSING',
            'FETCHING_DOCUMENT',
            'DOCUMENT_RECEIVED',
            'SENDING_TO_WHATSAPP',
            'RETRY_SCHEDULED',
          ]),
        },
      }),
      this.jobs.count({ where: { status: 'FAILED' } }),
      this.jobs.count({ where: { status: 'SENT' } }),
    ]);
    return { pending, failed, sent };
  }

  async lastSent(): Promise<WhatsAppDocumentJob | null> {
    return this.jobs.findOne({ where: { status: 'SENT' }, order: { sentAt: 'DESC' } });
  }
}
