import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import type { JobStatus, JobErrorCode } from '../job-status';

/**
 * One request to deliver one document to one WhatsApp recipient.
 *
 * The row is the unit of work, the audit record and the idempotency key all at once. Nothing
 * about a delivery lives anywhere else: if the process dies mid-flight, everything needed to
 * decide what to do next is on this row, which is what makes crash recovery a query rather
 * than a reconstruction.
 *
 * Timestamps are stored per stage rather than as a single `updatedAt` because the KPIs in §13
 * are differences between them — the document API's response time and WhatsApp's sending time
 * are separate numbers with separate owners, and an average that merges them tells nobody
 * which one to fix.
 */
@Entity('whatsapp_document_jobs')
@Index('IDX_wdj_status_priority', ['status', 'priority', 'createdAt'])
@Index('IDX_wdj_next_retry', ['status', 'nextRetryAt'])
@Index('IDX_wdj_client', ['clientId'])
@Index('IDX_wdj_party', ['partyId'])
@Index('IDX_wdj_created', ['createdAt'])
@Index('IDX_wdj_document_type', ['documentType'])
@Index('IDX_wdj_source_ack', ['sourceSystem', 'sourceAckAt'])
// The duplicate-send guard. A unique index rather than a check-then-insert, because two
// requests arriving at once both pass a check and only one can win an index.
@Index('IDX_wdj_idempotency', ['idempotencyKey'], { unique: true })
export class WhatsAppDocumentJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Human-quotable reference an operator can read down the phone: JOB-1001. */
  @Column({ type: 'varchar', length: 32, unique: true })
  reference!: string;

  /** Where the request came from: `software`, `agent`, `api`, `ui`. */
  @Column({ type: 'varchar', length: 24 })
  source!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  requestedByUserId!: string | null;

  @Column({ type: 'varchar', length: 64 })
  documentType!: string;

  @Column({ type: 'varchar', length: 190, nullable: true })
  documentName!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  documentReference!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  clientId!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  partyId!: string | null;

  @Column({ type: 'varchar', length: 190, nullable: true })
  recipientName!: string | null;

  /** Digits only, country code included. Normalised on the way in; one comparison form. */
  @Column({ type: 'varchar', length: 20 })
  recipientWhatsAppNumber!: string;

  @Column({ type: 'text', nullable: true })
  messageText!: string | null;

  /** What gets passed to the document API. Never credentials — see the registry's authProfile. */
  @Column({ type: jsonColumnType(), nullable: true })
  parametersJson!: Record<string, unknown> | null;

  /** Higher runs first. Ordinary work is 0; an operator waiting on a screen is worth more. */
  @Column({ type: 'int', default: 0 })
  priority!: number;

  @Column({ type: 'varchar', length: 32, default: 'PENDING' })
  status!: JobStatus;

  @Column({ type: 'varchar', length: 190 })
  idempotencyKey!: string;

  @Column({ type: 'int', default: 0 })
  attemptCount!: number;

  @Column({ type: 'int', default: 3 })
  maximumAttempts!: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  nextRetryAt!: Date | null;

  /** Which worker holds it. A worker id, so a stuck job can be traced to a process. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  claimedBy!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  claimedAt!: Date | null;

  /**
   * When another worker may take this job back.
   *
   * The lease is what makes a crash survivable. A worker that dies holding a job leaves the
   * row in flight with an expiry; the sweeper returns it once that passes, so the job resumes
   * instead of being lost — and, because the lease is checked on every write, a worker that
   * comes back from the dead cannot finish a job someone else has already taken over.
   */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  processingLeaseExpiresAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  documentUrl!: string | null;

  @Column({ type: 'varchar', length: 400, nullable: true })
  documentStorageKey!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  documentMimeType!: string | null;

  @Column({ type: 'int', nullable: true })
  documentSize!: number | null;

  @Column({ type: 'varchar', length: 190, nullable: true })
  whatsappMessageId!: string | null;

  @Column({ type: 'varchar', length: 48, nullable: true })
  errorCode!: JobErrorCode | null;

  /** Safe to show an operator: no stack traces, no headers, no secrets. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  errorMessage!: string | null;

  /** Stage-by-stage history for the timeline in §12. Append-only. */
  @Column({ type: jsonColumnType(), nullable: true })
  timeline!: Array<{ at: string; status: string; detail?: string | null }> | null;

  /** Which host system queued this, when it was not created here. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  sourceSystem!: string | null;

  /** That system's own id for the request, needed to acknowledge the delivery back to it. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sourceRef!: string | null;

  /**
   * When the host was told this was delivered.
   *
   * Separate from `sentAt` because delivering and acknowledging are two systems and either can
   * fail alone. A job that is SENT with no `sourceAckAt` is retried as an acknowledgement —
   * never as a second delivery.
   */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sourceAckAt!: Date | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  createdAt!: Date;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  startedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  documentReceivedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sentAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  updatedAt!: Date;
}
