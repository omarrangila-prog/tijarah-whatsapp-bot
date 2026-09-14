import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * One agent turn, recorded whatever became of it.
 *
 * This is the audit trail the brief's §12 asks for, and it is written for the awkward
 * cases rather than the happy ones: a turn that was refused, a tool call the permission
 * layer denied, a message that looked like an injection attempt. Those are the rows someone
 * will eventually need, and a log that only records successes cannot answer for them.
 *
 * `inboundText` stores what the sender actually wrote. It is evidence, so it is stored
 * verbatim — but everything that reads this table must treat it as untrusted data, exactly
 * as the runtime does.
 */
@Entity('agent_turns')
@Index('IDX_agent_turns_conversation', ['conversationId', 'createdAt'])
@Index('IDX_agent_turns_message', ['inboundMessageId'], { unique: true })
export class AgentTurn {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 16, default: 'whatsapp' })
  channel!: string;

  /**
   * The engine's message id.
   *
   * Unique, and that is the duplicate protection: WhatsApp engines redeliver on reconnect,
   * and a redelivered message must not produce a second turn — which would mean a second
   * reply to the customer, or a second approval request for the same action.
   */
  @Column({ type: 'varchar', length: 190 })
  inboundMessageId!: string;

  @Column({ type: 'varchar', length: 64 })
  conversationId!: string;

  @Column({ type: 'varchar', length: 20 })
  senderPhone!: string;

  @Column({ type: 'varchar', length: 16 })
  senderRole!: string;

  @Column({ type: 'text', nullable: true })
  inboundText!: string | null;

  /** Set when the security scan flagged the input; the turn still runs, restricted. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  injectionFlag!: string | null;

  @Column({ type: 'text', nullable: true })
  replyText!: string | null;

  /** Every tool the model asked for and what the permission layer did about it. */
  @Column({ type: jsonColumnType(), nullable: true })
  actions!: unknown;

  @Column({ type: 'varchar', length: 24, default: 'ok' })
  outcome!: 'ok' | 'refused' | 'halted' | 'rate_limited' | 'error' | 'ignored';

  @Column({ type: 'varchar', length: 500, nullable: true })
  outcomeDetail!: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  providerId!: string | null;

  @Column({ type: 'varchar', length: 80, nullable: true })
  model!: string | null;

  @Column({ type: 'int', default: 0 })
  inputTokens!: number;

  @Column({ type: 'int', default: 0 })
  outputTokens!: number;

  @Column({ type: 'int', default: 0 })
  durationMs!: number;

  /*
   * Millisecond precision, deliberately.
   *
   * `@CreateDateColumn()` on SQLite writes 'YYYY-MM-DD HH:MM:SS' — whole seconds — and this
   * column is a sort key (one turn against another inside the same second). Two rows written in the
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
