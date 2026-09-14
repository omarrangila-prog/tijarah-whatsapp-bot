import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn, Index } from 'typeorm';

/**
 * Per-tool permission, as the brief's §7 specifies.
 *
 * The default for anything not listed is REQUIRE_APPROVAL, decided in code rather than by
 * the absence of a row — a permission model that fails open when a row is missing is one
 * that grants a new tool full rights the moment it is registered.
 */
export type ToolPermissionLevel = 'ALLOW_AUTOMATICALLY' | 'REQUIRE_APPROVAL' | 'DENY';

@Entity('agent_tool_policies')
@Index('IDX_agent_tool_policies_scope', ['toolName', 'senderRole'], { unique: true })
export class AgentToolPolicy {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The registered tool name, e.g. `MessageSendText`. */
  @Column({ type: 'varchar', length: 80 })
  toolName!: string;

  /**
   * Whose request this policy governs.
   *
   * The same tool is a different proposition depending on who asked. `ContactFindAll` is
   * routine for an admin and an enumeration of the whole customer list for anyone else, so
   * the policy is keyed on both.
   */
  @Column({ type: 'varchar', length: 16 })
  senderRole!: 'admin' | 'staff' | 'customer' | 'unknown' | 'system';

  @Column({ type: 'varchar', length: 24, default: 'REQUIRE_APPROVAL' })
  level!: ToolPermissionLevel;

  /**
   * Recipients this tool may act on without approval, when `ALLOW_AUTOMATICALLY`.
   *
   * Empty means "any recipient", which is deliberately the more dangerous setting and so is
   * never the default for a sending tool. Digits-only E.164, matching the allowlist.
   */
  @Column({ type: 'simple-array', nullable: true })
  allowedRecipients!: string[] | null;

  /** Free-text note shown on the policy screen, so a decision is explainable later. */
  @Column({ type: 'varchar', length: 300, nullable: true })
  note!: string | null;

  @UpdateDateColumn()
  updatedAt!: Date;
}
