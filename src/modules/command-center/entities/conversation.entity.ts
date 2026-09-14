import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn, Index, Unique } from 'typeorm';
import { dateColumnType } from '../../../common/utils/column-types';
import { DateTransformer } from '../../../common/transformers/date.transformer';

/** Workflow state of a conversation. OPEN → WAITING (awaiting the customer) → RESOLVED. */
export enum ConversationStatus {
  OPEN = 'open',
  WAITING = 'waiting',
  RESOLVED = 'resolved',
}

export enum ConversationPriority {
  LOW = 'low',
  NORMAL = 'normal',
  HIGH = 'high',
  URGENT = 'urgent',
}

/**
 * The business object wrapped around a WhatsApp chat, keyed by (sessionId, chatId).
 *
 * Two things live here on purpose:
 *
 *  1. **Workflow state** — status, priority, assignee, team, star/mute. None of this exists in
 *     WhatsApp or in OpenWA today.
 *  2. **A denormalized inbox index** — lastMessageAt / preview / direction / unreadCount, plus the
 *     response-timing marks. This is derived from `messages`, which stays the source of truth for
 *     bodies, media and delivery state. It is stored rather than recomputed because the unified
 *     inbox must sort, filter and paginate across every session in ONE indexed query: deriving
 *     "newest message per chat" per request means a GROUP BY over the hot messages table on every
 *     keystroke. The recorder that maintains it runs inside the projector's at-most-once dispatch,
 *     so the counters cannot double-count engine re-fires.
 *
 * `firstInboundAt` / `firstResponseAt` / `resolvedAt` are what make average first-response time and
 * average resolution time real numbers instead of invented ones — nothing else in the schema can
 * answer "when did an agent first reply to this customer".
 */
@Entity('cc_conversations')
@Unique('UQ_cc_conversations_session_chat', ['sessionId', 'chatId'])
// The inbox's default ordering, scoped to a session.
@Index('IDX_cc_conversations_session_lastMessageAt', ['sessionId', 'lastMessageAt'])
// Cross-session ordering for the "All conversations" view.
@Index('IDX_cc_conversations_lastMessageAt', ['lastMessageAt'])
@Index('IDX_cc_conversations_status', ['status'])
@Index('IDX_cc_conversations_assigneeId', ['assigneeId'])
export class Conversation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** varchar, not uuid — matches `sessions.id`, same reasoning as `webhooks.sessionId`. */
  @Column({ type: 'varchar' })
  sessionId!: string;

  /** The WhatsApp chat JID, verbatim as the engine reports it. */
  @Column({ type: 'varchar', length: 190 })
  chatId!: string;

  /** Cached display name so the inbox list needs no engine round-trip. Refreshed on each message. */
  @Column({ type: 'varchar', length: 190, nullable: true })
  chatName!: string | null;

  /** Engine chat kind (individual/group/channel/…) so the list can filter groups out. */
  @Column({ type: 'varchar', length: 20, default: 'individual' })
  kind!: string;

  @Column({ type: 'varchar', length: 20, default: ConversationStatus.OPEN })
  status!: ConversationStatus;

  @Column({ type: 'varchar', length: 20, default: ConversationPriority.NORMAL })
  priority!: ConversationPriority;

  /** `cc_agents.id`, or null when unassigned. */
  @Column({ type: 'varchar', nullable: true })
  assigneeId!: string | null;

  /** `cc_teams.id`, or null. A conversation can be routed to a team before an individual claims it. */
  @Column({ type: 'varchar', nullable: true })
  teamId!: string | null;

  @Column({ type: 'boolean', default: false })
  starred!: boolean;

  @Column({ type: 'boolean', default: false })
  muted!: boolean;

  // ---- denormalized inbox index (derived from `messages`) ----

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastMessageAt!: Date | null;

  /** Truncated snippet — never media bytes. The recorder caps it at 240 chars. */
  @Column({ type: 'varchar', length: 260, nullable: true })
  lastMessagePreview!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  lastMessageType!: string | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  lastMessageDirection!: 'incoming' | 'outgoing' | null;

  /** Incoming messages since the conversation was last marked read. Reset by markRead. */
  @Column({ type: 'int', default: 0 })
  unreadCount!: number;

  /** Set by an explicit "mark as unread" so the badge survives a refetch that finds no new mail. */
  @Column({ type: 'boolean', default: false })
  manualUnread!: boolean;

  // ---- response timing (the basis of every duration metric) ----

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  firstInboundAt!: Date | null;

  /** When an agent first replied after `firstInboundAt`. Null while the customer is still waiting. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  firstResponseAt!: Date | null;

  /** Start of the CURRENT waiting spell — reset on every resolve/reopen so re-opens are measured. */
  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  pendingSince!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  resolvedAt!: Date | null;

  @Column({ type: dateColumnType(), nullable: true, transformer: DateTransformer })
  lastReadAt!: Date | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}
