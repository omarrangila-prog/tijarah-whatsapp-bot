import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';
import { jsonColumnType } from '../../../common/utils/column-types';

/**
 * One evaluation of one flow.
 *
 * Skipped and failed runs are recorded too, with the reason — an operator debugging "why did my
 * rule not fire" needs the negative cases far more than the positive ones.
 */
@Entity('cc_automation_executions')
@Index('IDX_cc_automation_executions_flowId', ['flowId'])
@Index('IDX_cc_automation_executions_createdAt', ['createdAt'])
export class AutomationExecution {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  flowId!: string;

  /** Denormalized so the log stays readable after a flow is renamed or deleted. */
  @Column({ type: 'varchar', length: 120, nullable: true })
  flowName!: string | null;

  @Column({ type: 'varchar', nullable: true })
  conversationId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  sessionId!: string | null;

  @Column({ type: 'varchar', length: 190, nullable: true })
  chatId!: string | null;

  @Column({ type: 'varchar', length: 20 })
  outcome!: 'matched' | 'skipped' | 'failed';

  /** Why it was skipped ('conditions_unmet', 'cooldown', 'loop_guard') or how it failed. */
  @Column({ type: 'varchar', length: 240, nullable: true })
  reason!: string | null;

  /** Per-action results, in order: `[{ type, ok, detail? }]`. */
  @Column({ type: jsonColumnType(), nullable: true })
  actionResults!: Array<{ type: string; ok: boolean; detail?: string }> | null;

  @CreateDateColumn()
  createdAt!: Date;
}
