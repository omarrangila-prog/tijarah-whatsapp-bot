import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * A prepared action waiting on a human.
 *
 * The row holds everything needed to execute the action later *and* everything needed to
 * describe it now, because those are read at different times by different people. The
 * describing half is what an admin sees on WhatsApp; the executing half is what runs after
 * they reply APPROVE.
 *
 * `state` is deliberately not just pending/done. An approval that expired, one that was
 * edited before sending, and one that failed at the engine are three different stories, and
 * collapsing them would make the audit trail useless in exactly the cases someone is asking
 * about it.
 */
export type ApprovalState = 'pending' | 'approved' | 'executed' | 'rejected' | 'expired' | 'failed';

@Entity('agent_approvals')
@Index('IDX_agent_approvals_reference', ['reference'], { unique: true })
@Index('IDX_agent_approvals_state', ['state', 'expiresAt'])
export class AgentApproval {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The human-quotable id: `APR-1001`. What an admin types back. */
  @Column({ type: 'varchar', length: 24 })
  reference!: string;

  /** The registered tool this will invoke, and the validated input it will invoke it with. */
  @Column({ type: 'varchar', length: 80 })
  toolName!: string;

  @Column({ type: jsonColumnType() })
  toolInput!: Record<string, unknown>;

  /**
   * The summary shown to the approver.
   *
   * Rendered when the approval is created, from the same values that will be executed —
   * not re-rendered at approval time. An approver must be shown what they are approving,
   * and a summary regenerated later could describe something that has since changed.
   */
  @Column({ type: 'text' })
  summary!: string;

  /** Who asked, so an approval can never be granted by the person who requested it. */
  @Column({ type: 'varchar', length: 20 })
  requestedByPhone!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  recipientPhone!: string | null;

  @Column({ type: 'varchar', length: 190, nullable: true })
  recipientLabel!: string | null;

  /**
   * The financial figures quoted in the prepared message, captured at preparation time.
   *
   * Re-checked immediately before execution (brief §8). If the balance moved between
   * preparation and approval — the customer paid in the meantime — the action does not run
   * on the old number.
   */
  @Column({ type: jsonColumnType(), nullable: true })
  verifiedContext!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  state!: ApprovalState;

  /**
   * Single-use, enforced by the database rather than by a check-then-act.
   *
   * Two APPROVE replies arriving together would otherwise both pass a "is it pending?" read
   * and both send. The unique index on this column makes the second one a constraint
   * violation instead of a duplicate message to a customer.
   */
  @Index('IDX_agent_approvals_idem', { unique: true })
  @Column({ type: 'varchar', length: 80, nullable: true })
  idempotencyKey!: string | null;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  expiresAt!: Date;

  @Column({ type: 'varchar', length: 20, nullable: true })
  decidedByPhone!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  decidedAt!: Date | null;

  /** The engine's message id, once the approved action actually sent something. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  resultMessageId!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  failureReason!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  conversationId!: string | null;

  @Column({ type: 'uuid', nullable: true })
  turnId!: string | null;

  /*
   * Millisecond precision, deliberately.
   *
   * `@CreateDateColumn()` on SQLite writes 'YYYY-MM-DD HH:MM:SS' — whole seconds — and this
   * column is a sort key (two prepared actions raised in the same second). Two rows written in the
   * same second then came back in arbitrary order, which an audit trail cannot afford: the
   * question it exists to answer is what happened before what. The repo's cross-dialect
   * pattern stores an ISO-8601 string on SQLite (lexicographic order == chronological order)
   * and a native timestamp on Postgres.
   *
   * It must be set explicitly at every insert. A column default cannot cover it: the value
   * passes through DateTransformer, which turns an absent value into an explicit NULL, so
   * the default never fires. An `@BeforeInsert` hook does not cover it either — TypeORM
   * skips entity listeners for the plain object literals `save()` accepts.
   */
  @Column({ type: dateColumnType(), transformer: DateTransformer })
  createdAt!: Date;
}
