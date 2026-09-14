import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export enum BroadcastStatus {
  DRAFT = 'draft',
  /** Audience + copy locked, waiting for a human to approve. Nothing is sent in this state. */
  PENDING_APPROVAL = 'pending_approval',
  SCHEDULED = 'scheduled',
  SENDING = 'sending',
  PAUSED = 'paused',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
}

/** The audience query. Every filter is ANDed; consent is applied on top and is not optional. */
export interface BroadcastAudience {
  tagIds?: string[];
  customerType?: string | null;
  city?: string | null;
  /** Restrict to people who have talked to these sessions. */
  sessionIds?: string[];
}

/**
 * An outbound campaign to **opted-in contacts only**.
 *
 * The consent gate is not a filter the operator can turn off: `BroadcastService` intersects every
 * audience with `cc_contact_consent.status = 'opted_in'` unconditionally, and a recipient whose
 * consent is later withdrawn is skipped at send time as well as at build time. Sends are paced by
 * `throttleMs` (floored server-side) so a campaign cannot burst a number into a WhatsApp block.
 */
@Entity('cc_broadcasts')
@Index('IDX_cc_broadcasts_status', ['status'])
export class Broadcast {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  name!: string;

  /** The number the campaign sends from. */
  @Column({ type: 'varchar' })
  sessionId!: string;

  /** Supports the same `{{name}}`/`{{phone}}` variables as quick replies. */
  @Column({ type: 'text' })
  body!: string;

  @Column({ type: jsonColumnType(), nullable: true })
  audience!: BroadcastAudience | null;

  @Column({ type: 'varchar', length: 20, default: BroadcastStatus.DRAFT })
  status!: BroadcastStatus;

  /** Gap between sends, in ms. Clamped to a conservative floor by the service. */
  @Column({ type: 'int', default: 3000 })
  throttleMs!: number;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  scheduledAt!: Date | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  approvedBy!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  approvedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  startedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  totalRecipients!: number;

  @Column({ type: 'int', default: 0 })
  sentCount!: number;

  @Column({ type: 'int', default: 0 })
  failedCount!: number;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
