import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

export enum FollowUpStatus {
  PENDING = 'pending',
  DONE = 'done',
  CANCELLED = 'cancelled',
}

/** A dated reminder attached to a conversation. Never sends anything by itself. */
@Entity('cc_follow_ups')
@Index('IDX_cc_follow_ups_due', ['status', 'dueAt'])
@Index('IDX_cc_follow_ups_conversationId', ['conversationId'])
export class FollowUp {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  assigneeId!: string | null;

  @Column({ type: 'varchar', length: 190 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  dueAt!: Date;

  @Column({ type: 'varchar', length: 20, default: FollowUpStatus.PENDING })
  status!: FollowUpStatus;

  /** 'manual' | 'ai' | 'automation' — where the follow-up came from. */
  @Column({ type: 'varchar', length: 20, default: 'manual' })
  createdVia!: string;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  completedAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
