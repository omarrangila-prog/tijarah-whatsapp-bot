import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';
import type { DraftLineItem } from './draft-schema';

/**
 * `SUBMITTED` means waiting on Tijarah's approval screen; `APPROVED` means a person there
 * accepted it and the finished document has been queued for delivery. The two are separate
 * because only the first is worth polling the host about.
 */
export const DRAFT_STATUSES = [
  'COLLECTING',
  'READY',
  'SUBMITTED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
  'FAILED',
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

/**
 * A document being composed in a WhatsApp conversation, before anyone approves it.
 *
 * Phase Three lets a person create a document by chatting. What that produces is a row here —
 * never an entry in the accounting system. When it is complete it is submitted to Tijarah
 * Books' **approval screen**, where a human accepts or rejects it. Nothing in this codebase
 * posts a final entry, and `submittedRef` records what the host called the pending record so
 * the two can be reconciled.
 *
 * One draft per person at a time, enforced by the partial index below: a conversation that
 * could hold two half-built invoices at once would silently put an answer on the wrong one.
 */
@Entity('document_drafts')
@Index('IDX_draft_reference', ['reference'], { unique: true })
@Index('IDX_draft_owner', ['createdByPhone', 'status'])
@Index('IDX_draft_status', ['status', 'createdAt'])
export class DocumentDraft {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Human-quotable: DRAFT-1001. */
  @Column({ type: 'varchar', length: 32 })
  reference!: string;

  @Column({ type: 'varchar', length: 64 })
  documentType!: string;

  @Column({ type: 'varchar', length: 190 })
  displayName!: string;

  /** The WhatsApp number composing it. Answers are only ever accepted from this number. */
  @Column({ type: 'varchar', length: 20 })
  createdByPhone!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  conversationId!: string | null;

  @Column({ type: 'varchar', length: 24, default: 'COLLECTING' })
  status!: DraftStatus;

  /** Field name → value, as collected so far. */
  @Column({ type: jsonColumnType(), nullable: true })
  fields!: Record<string, string> | null;

  @Column({ type: jsonColumnType(), nullable: true })
  lineItems!: DraftLineItem[] | null;

  /**
   * What the host called the pending record it created.
   *
   * Present only after a successful submission, and the proof that what happened was a
   * submission for approval rather than an entry: it is the approval screen's own id.
   */
  @Column({ type: 'varchar', length: 120, nullable: true })
  submittedRef!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  submittedAt!: Date | null;

  /** Safe to show the person who composed it: no stack traces, no credentials. */
  @Column({ type: 'varchar', length: 500, nullable: true })
  errorMessage!: string | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  createdAt!: Date;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  updatedAt!: Date;
}
