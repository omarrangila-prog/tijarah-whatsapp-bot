import { Entity, Column, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * How inbound conversations are distributed across agents.
 *
 * `manual` leaves everything unassigned for agents to claim — correct for a small team that can see
 * the whole queue. The other two are for when nobody can watch the whole queue any more.
 */
export enum RoutingStrategy {
  /** Nobody is assigned automatically; agents claim from the queue. */
  MANUAL = 'manual',
  /** Each new conversation goes to the next agent in turn. */
  ROUND_ROBIN = 'round_robin',
  /** Each new conversation goes to whoever currently holds the fewest open ones. */
  LEAST_BUSY = 'least_busy',
}

/**
 * Workspace-wide settings. Exactly one row, keyed by a fixed id.
 *
 * A single-row table rather than env vars because these are operational decisions a supervisor
 * changes during a shift — "we're swamped, switch to least-busy" — not deployment configuration
 * that warrants a restart.
 */
@Entity('cc_workspace_settings')
export class WorkspaceSettings {
  /** Always `default`. The row is created on first read. */
  @PrimaryColumn({ type: 'varchar', length: 20 })
  id!: string;

  @Column({ type: 'varchar', length: 20, default: RoutingStrategy.MANUAL })
  routingStrategy!: RoutingStrategy;

  /** Restrict routing to one team's members. Null routes across every active agent. */
  @Column({ type: 'varchar', nullable: true })
  routingTeamId!: string | null;

  /**
   * Skip agents who are not currently online.
   *
   * On by default: assigning a conversation to someone who went home is worse than leaving it in
   * the queue, because it looks handled and nobody is handling it.
   */
  @Column({ type: 'boolean', default: true })
  routeToOnlineOnly!: boolean;

  /**
   * Refuse to auto-assign an agent already holding this many open conversations. 0 = no ceiling.
   * Protects the load balancer from making a bad situation worse when everyone is at capacity —
   * an over-cap queue stays visible and claimable rather than being buried in someone's inbox.
   */
  @Column({ type: 'int', default: 0 })
  maxOpenPerAgent!: number;

  /**
   * When on, an agent sees only their own conversations plus the unassigned queue; a conversation
   * another agent owns is invisible to them. Admins always see everything — supervision is the one
   * role that cannot function behind this fence.
   *
   * Enforced server-side (list query, single-conversation reads, and the realtime fan-out), never
   * by the client: a filter the browser applies is a display preference, not a privacy boundary.
   */
  @Column({ type: 'boolean', default: false })
  privateAssignedChats!: boolean;

  /** Minutes of silence after which an agent is treated as away for routing purposes. */
  @Column({ type: 'int', default: 5 })
  presenceTimeoutMinutes!: number;

  @UpdateDateColumn()
  updatedAt!: Date;
}
