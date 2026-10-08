import { Entity, PrimaryColumn, Column, UpdateDateColumn } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/**
 * How much the agent is allowed to do on its own.
 *
 * A single row (`id = 'default'`), because this deployment serves one business. Kept as a
 * row rather than environment variables so an administrator can change the mode from the
 * dashboard without a redeploy — and so every change lands in the audit trail, which an
 * env var never would.
 */
export type AgentMode = 'manual' | 'assisted' | 'automatic';

@Entity('agent_settings')
export class AgentSettings {
  @PrimaryColumn({ type: 'varchar', length: 32 })
  id!: string;

  /**
   * The ceiling for the whole deployment.
   *
   * `manual` — the agent prepares, a human sends. `assisted` — the agent drafts and
   * recommends, a human approves. `automatic` — pre-authorised tools may run unattended.
   *
   * Defaults to `manual`: a business opts in to automation, it is never opted in for them.
   * A per-tool policy may be stricter than the mode but never bolder.
   */
  @Column({ type: 'varchar', length: 16, default: 'manual' })
  mode!: AgentMode;

  /**
   * The kill switch (brief §13).
   *
   * Checked at the top of every turn and before every tool call, not just at dispatch —
   * a stop that only takes effect on the next message is not a stop. While set, the agent
   * still reads and records messages but performs no outbound action of any kind.
   */
  @Column({ type: 'boolean', default: false })
  automationHalted!: boolean;

  @Column({ type: 'varchar', length: 190, nullable: true })
  haltedReason!: string | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  haltedAt!: Date | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  haltedBy!: string | null;

  /** How the agent treats a number it has never seen. */
  @Column({ type: 'varchar', length: 16, default: 'ignore' })
  unknownSenderPolicy!: 'ignore' | 'welcome';

  @Column({ type: 'text', nullable: true })
  unknownSenderMessage!: string | null;

  /* ------------------------------------------------------------ limits */

  /** Local time the agent will not send before or after. Applies to automation only. */
  @Column({ type: 'varchar', length: 5, default: '09:00' })
  quietHoursEnd!: string;

  @Column({ type: 'varchar', length: 5, default: '21:00' })
  quietHoursStart!: string;

  @Column({ type: 'varchar', length: 64, default: 'Asia/Karachi' })
  timezone!: string;

  /**
   * Ceiling on unattended outbound messages per day.
   *
   * A runaway loop is the failure this exists for — an agent that misreads a reply as a
   * request and answers its own answer. The cap turns that from an incident into a
   * nuisance.
   */
  @Column({ type: 'int', default: 200 })
  maxAutomaticSendsPerDay!: number;

  /** Per counterparty, so one customer cannot be messaged repeatedly by a stuck rule. */
  @Column({ type: 'int', default: 5 })
  maxAutomaticSendsPerContactPerDay!: number;

  /** How long an approval stays actionable before it must be prepared again. */
  @Column({ type: 'int', default: 60 })
  approvalTtlMinutes!: number;

  /**
   * Model turns per sender per hour, so a chatty number cannot exhaust the model budget.
   *
   * 30 was too low for the way the bot is actually used: composing one invoice is a dozen
   * short messages, and a client doing that then asking for a report hit the cap mid-draft
   * and was told to try again later — with a half-finished invoice open. 120 still bounds a
   * runaway loop while leaving room for a normal working session.
   */
  @Column({ type: 'int', default: 120 })
  maxTurnsPerSenderPerHour!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}
