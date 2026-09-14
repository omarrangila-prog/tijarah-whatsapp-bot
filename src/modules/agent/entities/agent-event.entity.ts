import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { jsonColumnType, dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * A scheduled or system-raised event awaiting the agent (brief §11).
 *
 * The cron job's entire job is to insert one of these. It does not send anything, does not
 * decide anything, and does not talk to WhatsApp — because a scheduler that can send is a
 * second path to a customer that bypasses every rule the agent enforces.
 *
 * The row survives restarts, which is the other half of §11: work queued at 09:00 is still
 * there at 09:05 after a deploy.
 */
@Entity('agent_events')
@Index('IDX_agent_events_key', ['eventKey'], { unique: true })
@Index('IDX_agent_events_due', ['state', 'runAfter'])
export class AgentEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 40 })
  eventType!: string;

  /**
   * Deduplication, in the database rather than in the scheduler.
   *
   * Encodes what the event is about — "overdue:INV-1001:2026-09-03". An overlapping cron
   * run, a retry after a crash, or two workers racing all converge on one row, because the
   * second insert violates this index instead of creating a second reminder.
   */
  @Column({ type: 'varchar', length: 190 })
  eventKey!: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  subjectPhone!: string | null;

  @Column({ type: 'varchar', length: 190, nullable: true })
  subjectContactId!: string | null;

  @Column({ type: jsonColumnType(), nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  state!: 'pending' | 'processing' | 'done' | 'skipped' | 'failed';

  /** Why an event produced nothing. A silently dropped event is the worst kind of bug here. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  outcomeDetail!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: dateColumnType(), transformer: DateTransformer })
  runAfter!: Date;

  @Column({ type: 'uuid', nullable: true })
  turnId!: string | null;

  /*
   * Millisecond precision, deliberately.
   *
   * `@CreateDateColumn()` on SQLite writes 'YYYY-MM-DD HH:MM:SS' — whole seconds — and this
   * column is a sort key (two events queued in the same second). Two rows written in the
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
