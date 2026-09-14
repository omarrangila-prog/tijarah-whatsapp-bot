import { Entity, PrimaryGeneratedColumn, Column, Index } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * The allowlist of numbers that may instruct the agent.
 *
 * This is the security boundary of the whole feature. A number on this list can ask the
 * agent to look things up and to prepare messages to customers; a number not on it is a
 * customer or a stranger, and gets the restricted experience.
 *
 * It is an explicit table rather than a config string for two reasons: an allowlist that
 * lives in an environment variable cannot be audited, and it cannot record *who* added an
 * entry — which is the first question asked when an unexpected number turns out to have
 * admin rights.
 *
 * Numbers are stored as E.164 digits with no punctuation and no leading `+`, which is the
 * one form every comparison uses.
 */
@Entity('agent_admin_numbers')
@Index('IDX_agent_admin_numbers_phone', ['phoneE164'], { unique: true })
export class AgentAdminNumber {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Digits only, country code included. `923001234567`, never `+92 300 1234567`. */
  @Column({ type: 'varchar', length: 20 })
  phoneE164!: string;

  @Column({ type: 'varchar', length: 120 })
  label!: string;

  /**
   * What this number may do.
   *
   * `admin` maps to ApiKeyRole.ADMIN and may approve; `staff` maps to OPERATOR and may
   * prepare and ask, but its approvals are refused — approving one's own request is not an
   * approval, and staff requests are the ones most worth a second pair of eyes.
   */
  @Column({ type: 'varchar', length: 16, default: 'admin' })
  role!: 'admin' | 'staff';

  /**
   * The API key this number acts as.
   *
   * The agent does not invent a permission model. Every tool call it makes is executed
   * through the existing `invokeTool`, authenticated with a real key — so an admin over
   * WhatsApp has exactly the rights that key has, no more, and revoking the key revokes
   * their WhatsApp access at the same time.
   */
  @Column({ type: 'uuid', nullable: true })
  apiKeyId!: string | null;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'varchar', length: 120, nullable: true })
  addedBy!: string | null;

  /*
   * Millisecond precision, deliberately.
   *
   * `@CreateDateColumn()` on SQLite writes 'YYYY-MM-DD HH:MM:SS' — whole seconds — and this
   * column is a sort key (two numbers added in the same second). Two rows written in the
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
