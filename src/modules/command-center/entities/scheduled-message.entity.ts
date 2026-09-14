import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export enum ScheduledMessageStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

/** A text message queued for a later time. Drained by a periodic tick in ScheduledMessageService. */
@Entity('cc_scheduled_messages')
@Index('IDX_cc_scheduled_messages_due', ['status', 'runAt'])
export class ScheduledMessage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  sessionId!: string;

  @Column({ type: 'varchar', length: 190 })
  chatId!: string;

  @Column({ type: 'text' })
  body!: string;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  runAt!: Date;

  @Column({ type: 'varchar', length: 20, default: ScheduledMessageStatus.PENDING })
  status!: ScheduledMessageStatus;

  @Column({ type: 'varchar', length: 240, nullable: true })
  error!: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  createdBy!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  sentAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;
}
