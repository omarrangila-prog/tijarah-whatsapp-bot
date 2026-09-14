import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export enum BroadcastRecipientStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
  /** Consent was withdrawn between audience build and send. */
  SKIPPED = 'skipped',
}

/** One person in one campaign. Rows are materialized when the campaign is approved. */
@Entity('cc_broadcast_recipients')
@Index('IDX_cc_broadcast_recipients_broadcastId', ['broadcastId'])
@Index('IDX_cc_broadcast_recipients_pending', ['broadcastId', 'status'])
export class BroadcastRecipient {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  broadcastId!: string;

  @Column({ type: 'varchar', length: 190 })
  waId!: string;

  @Column({ type: 'varchar', length: 120, nullable: true })
  name!: string | null;

  @Column({ type: 'varchar', length: 20, default: BroadcastRecipientStatus.PENDING })
  status!: BroadcastRecipientStatus;

  /** The engine message id, so delivery/read acks can be matched back to the campaign. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  waMessageId!: string | null;

  @Column({ type: 'varchar', length: 240, nullable: true })
  error!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sentAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
