import { ForbiddenException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { canSeeConversation, needsVisibilityFence, type ConversationActor } from './visibility';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, type SelectQueryBuilder } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { resolveSessionScope } from '../../common/security/session-scope';
import { Message, MessageDirection } from '../message/entities/message.entity';
import { Conversation, ConversationPriority, ConversationStatus } from './entities/conversation.entity';
import { ConversationTag } from './entities/conversation-tag.entity';
import { Tag } from './entities/tag.entity';
import { AssignmentHistory } from './entities/assignment-history.entity';
import { buildPreview, nextStatusOnInbound, nextStatusOnOutbound } from './conversation-state';

/** The realtime producer the service notifies; injected optionally so unit tests need no gateway. */
export interface ConversationEventSink {
  emitConversationUpdated(sessionId: string, conversation: Conversation): void;
}

/**
 * DI token for {@link ConversationEventSink}.
 *
 * Declared above the class on purpose: the `@Inject(CONVERSATION_EVENT_SINK)` decorator is
 * evaluated when the class is defined, so a token declared further down the file would still be in
 * its temporal dead zone and throw at module load.
 */
export const CONVERSATION_EVENT_SINK = Symbol('CONVERSATION_EVENT_SINK');

/** Filters accepted by the unified-inbox list. Everything is optional and ANDed. */
export interface ConversationListFilters {
  sessionIds?: string[];
  status?: ConversationStatus;
  priority?: ConversationPriority;
  /** An agent id, `'unassigned'`, or `'me'` (resolved by the controller before it reaches here). */
  assigneeId?: string;
  teamId?: string;
  tagIds?: string[];
  unreadOnly?: boolean;
  starredOnly?: boolean;
  /** Matches contact name, chat id/phone digits, and message bodies. */
  search?: string;
  /** ISO dates bounding `lastMessageAt`. */
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** One contact identity discovered while backfilling, with the window its messages span. */
export interface BackfilledContact {
  chatId: string;
  name: string | null;
  firstAt: Date;
  lastAt: Date;
}

/** The shape the inbox list renders, conversation plus its resolved tags. */
export interface ConversationView extends Conversation {
  tags: Tag[];
}

/** One inbound or outbound message, as the recorder needs to see it. */
export interface RecordedMessage {
  chatId: string;
  chatName?: string | null;
  body?: string | null;
  type?: string;
  /** Unix SECONDS, as the engine reports it. Falls back to now when absent. */
  timestamp?: number;
  kind?: string;
}

const MAX_PAGE_SIZE = 100;

/**
 * Conversations: the business object wrapped around a WhatsApp chat.
 *
 * Reads and writes only `cc_*` tables plus a read-only join into `messages` for search — it never
 * mutates OpenWA's own data. Every write is scoped by a conversation id that the caller has already
 * been authorized for (see `assertSessionAllowed`).
 */
@Injectable()
export class ConversationService {
  private readonly logger = createLogger('ConversationService');

  constructor(
    @InjectRepository(Conversation, 'data')
    private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationTag, 'data')
    private readonly conversationTags: Repository<ConversationTag>,
    @InjectRepository(Tag, 'data')
    private readonly tags: Repository<Tag>,
    @InjectRepository(AssignmentHistory, 'data')
    private readonly history: Repository<AssignmentHistory>,
    @InjectRepository(Message, 'data')
    private readonly messages: Repository<Message>,
    // Injected by token, and optional: the sink is a thin adapter over the websocket gateway, and a
    // unit test constructing this service must not have to stand one up.
    @Optional()
    @Inject(CONVERSATION_EVENT_SINK)
    private readonly events?: ConversationEventSink,
  ) {}

  // ------------------------------------------------------------------ reads

  /**
   * The unified inbox query: one indexed scan over `cc_conversations`, newest activity first.
   *
   * `allowedSessions` is the calling key's fence and is applied on top of any requested session
   * filter — a request may narrow within the fence, never past it. An empty resolved scope returns
   * nothing rather than everything, which is what makes an out-of-scope request fail closed.
   */
  async list(
    filters: ConversationListFilters,
    allowedSessions?: string[] | null,
    visibility?: { actor: ConversationActor; privateAssignedChats: boolean },
  ): Promise<{ conversations: ConversationView[]; total: number }> {
    const scope = this.resolveScope(filters.sessionIds, allowedSessions);
    if (scope !== null && scope.length === 0) return { conversations: [], total: 0 };

    const limit = clamp(filters.limit, 25, 1, MAX_PAGE_SIZE);
    const offset = Math.max(0, Math.trunc(filters.offset ?? 0) || 0);

    const qb = this.conversations.createQueryBuilder('c');
    if (scope) qb.andWhere('c.sessionId IN (:...scope)', { scope });
    if (filters.status) qb.andWhere('c.status = :status', { status: filters.status });
    if (filters.priority) qb.andWhere('c.priority = :priority', { priority: filters.priority });
    if (filters.teamId) qb.andWhere('c.teamId = :teamId', { teamId: filters.teamId });
    if (filters.assigneeId === 'unassigned') {
      qb.andWhere('c.assigneeId IS NULL');
    } else if (filters.assigneeId) {
      qb.andWhere('c.assigneeId = :assigneeId', { assigneeId: filters.assigneeId });
    }
    if (filters.starredOnly) qb.andWhere('c.starred = :starred', { starred: true });
    if (filters.unreadOnly)
      qb.andWhere('(c.unreadCount > 0 OR c.manualUnread = :manualUnread)', { manualUnread: true });
    if (filters.from) qb.andWhere('c.lastMessageAt >= :from', { from: filters.from });
    if (filters.to) qb.andWhere('c.lastMessageAt <= :to', { to: filters.to });
    if (filters.tagIds?.length) {
      // EXISTS rather than a join: a conversation carrying two of the requested tags must appear
      // once, and a join would duplicate the row (and the count) per matching tag.
      qb.andWhere(
        `EXISTS (SELECT 1 FROM cc_conversation_tags ct WHERE ct."conversationId" = c.id AND ct."tagId" IN (:...tagIds))`,
        { tagIds: filters.tagIds },
      );
    }
    // Ownership fence. Applied as SQL rather than by filtering the page afterwards: post-filtering
    // would return short pages and a total that counts rows the caller may not see, so the inbox
    // would show "24 conversations" and list nine.
    if (visibility && needsVisibilityFence(visibility.actor, visibility.privateAssignedChats)) {
      const mine = visibility.actor.agentId;
      if (mine) {
        qb.andWhere('(c.assigneeId IS NULL OR c.assigneeId = :visibleTo)', { visibleTo: mine });
      } else {
        // A key linked to no agent owns nothing, so only the shared queue is visible to it.
        qb.andWhere('c.assigneeId IS NULL');
      }
    }

    this.applySearch(qb, filters.search, scope);

    // NULLS are ordered explicitly: a conversation created before its first message has a null
    // lastMessageAt, and the two dialects disagree on where nulls sort by default.
    qb.orderBy('CASE WHEN c.lastMessageAt IS NULL THEN 1 ELSE 0 END', 'ASC')
      .addOrderBy('c.lastMessageAt', 'DESC')
      .addOrderBy('c.id', 'DESC')
      .skip(offset)
      .take(limit);

    const [rows, total] = await qb.getManyAndCount();
    return { conversations: await this.attachTags(rows), total };
  }

  /**
   * Full-text-ish search across the three things an operator actually types: a person's name, their
   * number, and something they said.
   *
   * The message-body arm is an EXISTS subquery scoped to the same sessions, so it uses the
   * `(sessionId, createdAt)` index rather than scanning the whole message table, and it cannot leak
   * a body from a session the caller may not see.
   */
  private applySearch(qb: SelectQueryBuilder<Conversation>, search: string | undefined, scope: string[] | null): void {
    const term = search?.trim();
    if (!term) return;
    const like = `%${term.toLowerCase()}%`;
    // Digits-only comparison so "+92 300 1234567" matches a chatId of "923001234567@c.us".
    const digits = term.replace(/\D/g, '');

    const bodyScope = scope ? ` AND m."sessionId" IN (:...scope)` : '';
    const clauses = [
      `LOWER(c.chatName) LIKE :like`,
      `LOWER(c.chatId) LIKE :like`,
      `EXISTS (SELECT 1 FROM messages m WHERE m."chatId" = c."chatId"${bodyScope} AND LOWER(m.body) LIKE :like)`,
    ];
    if (digits.length >= 4) clauses.push(`c.chatId LIKE :digits`);

    qb.andWhere(`(${clauses.join(' OR ')})`, {
      like,
      ...(digits.length >= 4 ? { digits: `%${digits}%` } : {}),
      ...(scope ? { scope } : {}),
    });
  }

  async findById(
    id: string,
    allowedSessions?: string[] | null,
    visibility?: { actor: ConversationActor; privateAssignedChats: boolean },
  ): Promise<ConversationView> {
    const conversation = await this.conversations.findOne({ where: { id } });
    if (!conversation) throw new NotFoundException(`Conversation ${id} not found`);
    this.assertSessionAllowed(conversation.sessionId, allowedSessions);
    this.assertVisible(conversation.assigneeId, visibility);
    const [view] = await this.attachTags([conversation]);
    return view;
  }

  /** Resolve by natural key. Returns null instead of throwing — callers use it to test existence. */
  findByChat(sessionId: string, chatId: string): Promise<Conversation | null> {
    return this.conversations.findOne({ where: { sessionId, chatId } });
  }

  // ----------------------------------------------------------------- writes

  /**
   * Get or create the conversation for a chat.
   *
   * The unique `(sessionId, chatId)` constraint is the arbiter: two concurrent inbound messages for
   * a brand-new chat both try to insert, one loses, and the loser re-reads instead of failing. That
   * is why the catch re-queries rather than propagating.
   */
  async ensure(sessionId: string, chatId: string, seed: Partial<Conversation> = {}): Promise<Conversation> {
    const existing = await this.conversations.findOne({ where: { sessionId, chatId } });
    if (existing) return existing;
    const created = this.conversations.create({ sessionId, chatId, ...seed });
    try {
      return await this.conversations.save(created);
    } catch {
      const raced = await this.conversations.findOne({ where: { sessionId, chatId } });
      if (raced) return raced;
      throw new NotFoundException(`Conversation for ${chatId} could not be created`);
    }
  }

  /**
   * Fold an inbound (customer) message into the conversation index.
   *
   * Called from the projector's at-most-once dispatch, so `unreadCount` is a safe counter here —
   * an engine re-fire never reaches this point twice for the same message.
   */
  async recordInbound(sessionId: string, message: RecordedMessage): Promise<Conversation | null> {
    const at = toDate(message.timestamp);
    const conversation = await this.ensure(sessionId, message.chatId, {
      chatName: message.chatName ?? null,
      kind: message.kind ?? 'individual',
    });

    conversation.lastMessageAt = at;
    conversation.lastMessagePreview = buildPreview(message.type, message.body);
    conversation.lastMessageType = message.type ?? 'text';
    conversation.lastMessageDirection = 'incoming';
    conversation.unreadCount += 1;
    if (message.chatName) conversation.chatName = message.chatName;
    if (!conversation.firstInboundAt) conversation.firstInboundAt = at;
    // A new waiting spell starts only when none is open: consecutive customer messages must not
    // reset the clock, or first-response time would measure from the LAST nag instead of the first.
    if (!conversation.pendingSince) conversation.pendingSince = at;
    const next = nextStatusOnInbound();
    if (conversation.status !== next) {
      conversation.status = next;
      conversation.resolvedAt = null;
      // A reopened thread is unanswered again — clear the mark so the next agent reply is measured.
      conversation.firstResponseAt = null;
    }

    const saved = await this.conversations.save(conversation);
    this.events?.emitConversationUpdated(sessionId, saved);
    return saved;
  }

  /** Fold an outbound (agent or automation) message into the conversation index. */
  async recordOutbound(sessionId: string, message: RecordedMessage): Promise<Conversation | null> {
    const at = toDate(message.timestamp);
    const conversation = await this.ensure(sessionId, message.chatId, {
      chatName: message.chatName ?? null,
      kind: message.kind ?? 'individual',
    });

    // Guard against an out-of-order echo overwriting a newer message's snippet.
    if (!conversation.lastMessageAt || conversation.lastMessageAt <= at) {
      conversation.lastMessageAt = at;
      conversation.lastMessagePreview = buildPreview(message.type, message.body);
      conversation.lastMessageType = message.type ?? 'text';
      conversation.lastMessageDirection = 'outgoing';
    }
    // Replying is reading: the agent has clearly seen the thread.
    conversation.unreadCount = 0;
    conversation.manualUnread = false;
    conversation.lastReadAt = at;
    if (conversation.pendingSince && !conversation.firstResponseAt) {
      conversation.firstResponseAt = at;
    }
    conversation.pendingSince = null;
    conversation.status = nextStatusOnOutbound(conversation.status);

    const saved = await this.conversations.save(conversation);
    this.events?.emitConversationUpdated(sessionId, saved);
    return saved;
  }

  async markRead(id: string, allowedSessions?: string[] | null): Promise<Conversation> {
    const conversation = await this.load(id, allowedSessions);
    conversation.unreadCount = 0;
    conversation.manualUnread = false;
    conversation.lastReadAt = new Date();
    return this.persist(conversation);
  }

  /**
   * Mark unread. `manualUnread` exists because `unreadCount` is derived from arriving messages: a
   * conversation the agent has read has a count of 0, and setting it to 1 would invent a message.
   */
  async markUnread(id: string, allowedSessions?: string[] | null): Promise<Conversation> {
    const conversation = await this.load(id, allowedSessions);
    conversation.manualUnread = true;
    return this.persist(conversation);
  }

  async setStatus(id: string, status: ConversationStatus, allowedSessions?: string[] | null): Promise<Conversation> {
    const conversation = await this.load(id, allowedSessions);
    conversation.status = status;
    if (status === ConversationStatus.RESOLVED) {
      conversation.resolvedAt = new Date();
      conversation.pendingSince = null;
    } else if (conversation.resolvedAt) {
      // Reopening starts a fresh cycle so the next resolution time is measured from here, not from
      // the original inbound weeks ago.
      conversation.resolvedAt = null;
      conversation.pendingSince = conversation.pendingSince ?? new Date();
      conversation.firstResponseAt = null;
    }
    return this.persist(conversation);
  }

  async setPriority(
    id: string,
    priority: ConversationPriority,
    allowedSessions?: string[] | null,
  ): Promise<Conversation> {
    const conversation = await this.load(id, allowedSessions);
    conversation.priority = priority;
    return this.persist(conversation);
  }

  async setFlags(
    id: string,
    flags: { starred?: boolean; muted?: boolean },
    allowedSessions?: string[] | null,
  ): Promise<Conversation> {
    const conversation = await this.load(id, allowedSessions);
    if (flags.starred !== undefined) conversation.starred = flags.starred;
    if (flags.muted !== undefined) conversation.muted = flags.muted;
    return this.persist(conversation);
  }

  /**
   * Assign, reassign, claim or unassign — one method, because they differ only in what the caller
   * passes and every one of them must append the same history row.
   */
  async assign(
    id: string,
    input: { agentId?: string | null; teamId?: string | null; reason?: string },
    actor: string | null,
    allowedSessions?: string[] | null,
  ): Promise<Conversation> {
    const conversation = await this.load(id, allowedSessions);
    const previous = conversation.assigneeId;
    const nextAgent = input.agentId === undefined ? previous : input.agentId;

    if (input.agentId !== undefined) conversation.assigneeId = input.agentId;
    if (input.teamId !== undefined) conversation.teamId = input.teamId;

    const action = resolveAssignmentAction(previous, nextAgent, input.teamId !== undefined, actor);
    const saved = await this.persist(conversation);
    await this.history.save(
      this.history.create({
        conversationId: id,
        action,
        fromAgentId: previous,
        toAgentId: conversation.assigneeId,
        teamId: conversation.teamId,
        actor,
        reason: input.reason ?? null,
      }),
    );
    return saved;
  }

  /**
   * Hand a conversation from one agent to another.
   *
   * A transfer is not just an assignment: the outgoing agent knows something the incoming one does
   * not, and that knowledge is lost unless it travels with the conversation. So the handover note
   * is written into the conversation's internal notes as well as the assignment trail — the trail
   * answers "who has owned this", the note answers "what do I need to know", and those are read in
   * different places by different people.
   *
   * Status is reset to OPEN when the conversation was RESOLVED: transferring a closed conversation
   * means it is being reopened for someone to act on, and leaving it resolved would hide it from
   * the queue the receiving agent actually works.
   */
  async transfer(
    id: string,
    input: { toAgentId: string; note?: string; toTeamId?: string | null },
    actor: { id: string | null; name: string | null },
    allowedSessions?: string[] | null,
  ): Promise<Conversation> {
    const conversation = await this.load(id, allowedSessions);
    const previousAssignee = conversation.assigneeId;

    conversation.assigneeId = input.toAgentId;
    if (input.toTeamId !== undefined) conversation.teamId = input.toTeamId;
    if (conversation.status === ConversationStatus.RESOLVED) {
      conversation.status = ConversationStatus.OPEN;
      conversation.resolvedAt = null;
    }
    const saved = await this.persist(conversation);

    await this.history.save(
      this.history.create({
        conversationId: id,
        action: previousAssignee ? 'reassigned' : 'assigned',
        fromAgentId: previousAssignee,
        toAgentId: input.toAgentId,
        teamId: conversation.teamId,
        actor: actor.id ?? actor.name,
        reason: input.note?.trim() ? `Handover: ${input.note.trim()}` : 'Transferred',
      }),
    );

    return saved;
  }

  listAssignmentHistory(conversationId: string): Promise<AssignmentHistory[]> {
    return this.history.find({ where: { conversationId }, order: { createdAt: 'DESC' }, take: 50 });
  }

  // -------------------------------------------------------------------- tags

  /**
   * Attach a tag and return the refreshed conversation.
   *
   * Emits here rather than leaving it to the caller: every other mutation announces itself from
   * `persist()`, and a tag change that stayed silent would be the one update an open inbox missed.
   */
  async addTag(conversationId: string, tagId: string): Promise<ConversationView> {
    const exists = await this.conversationTags.findOne({ where: { conversationId, tagId } });
    if (!exists) {
      try {
        await this.conversationTags.save(this.conversationTags.create({ conversationId, tagId }));
      } catch (error) {
        // A concurrent add loses the unique race; the tag is on the conversation either way.
        this.logger.debug('Duplicate conversation tag ignored', { conversationId, tagId, error: String(error) });
      }
    }
    return this.reloadAndAnnounce(conversationId);
  }

  async removeTag(conversationId: string, tagId: string): Promise<ConversationView> {
    await this.conversationTags.delete({ conversationId, tagId });
    return this.reloadAndAnnounce(conversationId);
  }

  /** Re-read a conversation with its tags and broadcast the result. */
  private async reloadAndAnnounce(conversationId: string): Promise<ConversationView> {
    const conversation = await this.conversations.findOne({ where: { id: conversationId } });
    if (!conversation) throw new NotFoundException(`Conversation ${conversationId} not found`);
    const [view] = await this.attachTags([conversation]);
    this.events?.emitConversationUpdated(view.sessionId, view);
    return view;
  }

  /** Load every tag for a page of conversations in ONE query rather than one query per row. */
  private async attachTags(rows: Conversation[]): Promise<ConversationView[]> {
    if (rows.length === 0) return [];
    const links = await this.conversationTags.find({ where: { conversationId: In(rows.map(r => r.id)) } });
    if (links.length === 0) return rows.map(row => ({ ...row, tags: [] }));

    const tagRows = await this.tags.find({ where: { id: In([...new Set(links.map(l => l.tagId))]) } });
    const tagById = new Map(tagRows.map(tag => [tag.id, tag]));
    const byConversation = new Map<string, Tag[]>();
    for (const link of links) {
      const tag = tagById.get(link.tagId);
      if (!tag) continue;
      const list = byConversation.get(link.conversationId) ?? [];
      list.push(tag);
      byConversation.set(link.conversationId, list);
    }
    return rows.map(row => ({ ...row, tags: byConversation.get(row.id) ?? [] }));
  }

  // --------------------------------------------------------------- backfill

  /**
   * Build conversations from messages already in the database.
   *
   * A gateway that has been running before this feature existed has full history but no
   * conversation rows, and the inbox would look empty until new traffic arrived. This walks the
   * message table once per session and seeds the index — idempotent, so running it twice is
   * harmless, and it never overwrites workflow state an operator has already set.
   */
  async backfill(sessionIds: string[]): Promise<{ created: number; updated: number; contacts: BackfilledContact[] }> {
    let created = 0;
    let updated = 0;
    // Chat identities seen during the walk, with their first/last activity. Returned rather than
    // written here: seeding customer profiles is CustomerService's job, and reaching into its table
    // from this service would put the same write in two places.
    const contacts = new Map<string, BackfilledContact>();

    for (const sessionId of sessionIds) {
      // Newest message per chat, plus the counts the index needs. Grouping in SQL keeps this to one
      // round trip per session instead of one per chat.
      const rows = await this.messages
        .createQueryBuilder('m')
        .select('m.chatId', 'chatId')
        .addSelect('MAX(m.createdAt)', 'lastAt')
        .addSelect('COUNT(*)', 'total')
        .where('m.sessionId = :sessionId', { sessionId })
        .groupBy('m.chatId')
        .getRawMany<{ chatId: string; lastAt: string | Date; total: string | number }>();

      for (const row of rows) {
        if (!row.chatId) continue;
        const last = await this.messages.findOne({
          where: { sessionId, chatId: row.chatId },
          order: { createdAt: 'DESC' },
        });
        const first = await this.messages.findOne({
          where: { sessionId, chatId: row.chatId },
          order: { createdAt: 'ASC' },
        });
        const existing = await this.conversations.findOne({ where: { sessionId, chatId: row.chatId } });
        const lastAt = last?.createdAt ? new Date(last.createdAt) : new Date(row.lastAt);
        const firstAt = first?.createdAt ? new Date(first.createdAt) : lastAt;

        // Only 1:1 chats denote a person. A group id is not a customer, and seeding one would put
        // groups in the Contacts book.
        if (!row.chatId.includes('@g.us')) {
          const seen = contacts.get(row.chatId);
          contacts.set(row.chatId, {
            chatId: row.chatId,
            name: seen?.name ?? last?.chatName ?? null,
            firstAt: seen && seen.firstAt < firstAt ? seen.firstAt : firstAt,
            lastAt: seen && seen.lastAt > lastAt ? seen.lastAt : lastAt,
          });
        }

        if (!existing) {
          await this.conversations.save(
            this.conversations.create({
              sessionId,
              chatId: row.chatId,
              chatName: last?.chatName ?? null,
              kind: row.chatId.includes('@g.us') ? 'group' : 'individual',
              lastMessageAt: lastAt,
              lastMessagePreview: buildPreview(last?.type, last?.body),
              lastMessageType: last?.type ?? null,
              lastMessageDirection: last?.direction === MessageDirection.INCOMING ? 'incoming' : 'outgoing',
              // Backfill deliberately seeds zero unread: inventing a badge for history the operator
              // has already dealt with would be worse than starting clean.
              unreadCount: 0,
            }),
          );
          created += 1;
        } else if (
          !existing.lastMessageAt ||
          existing.lastMessageAt < lastAt ||
          // Repair, not just fill: a row whose preview is empty while messages plainly exist is
          // stale index data (an older build produced none for message kinds it did not label), and
          // the inbox renders it as though the conversation were empty.
          !existing.lastMessagePreview
        ) {
          existing.lastMessageAt = lastAt;
          existing.lastMessagePreview = buildPreview(last?.type, last?.body);
          existing.lastMessageType = last?.type ?? null;
          existing.lastMessageDirection = last?.direction === MessageDirection.INCOMING ? 'incoming' : 'outgoing';
          if (!existing.chatName && last?.chatName) existing.chatName = last.chatName;
          await this.conversations.save(existing);
          updated += 1;
        }
      }
    }

    this.logger.log('Conversation backfill complete', {
      sessions: sessionIds.length,
      created,
      updated,
      contacts: contacts.size,
    });
    return { created, updated, contacts: [...contacts.values()] };
  }

  // --------------------------------------------------------------- internals

  private async load(
    id: string,
    allowedSessions?: string[] | null,
    visibility?: { actor: ConversationActor; privateAssignedChats: boolean },
  ): Promise<Conversation> {
    const conversation = await this.conversations.findOne({ where: { id } });
    if (!conversation) throw new NotFoundException(`Conversation ${id} not found`);
    this.assertSessionAllowed(conversation.sessionId, allowedSessions);
    this.assertVisible(conversation.assigneeId, visibility);
    return conversation;
  }

  /**
   * Refuse a conversation the caller is not entitled to see.
   *
   * 404 rather than 403, and deliberately: 403 would confirm that a conversation with this id
   * exists and belongs to a named colleague, which is itself the information the fence exists to
   * withhold. The session fence above answers 403 because a scoped key already knows its own
   * sessions — nothing is revealed there that the caller did not supply.
   */
  private assertVisible(
    assigneeId: string | null,
    visibility?: { actor: ConversationActor; privateAssignedChats: boolean },
  ): void {
    if (!visibility) return;
    if (!canSeeConversation(assigneeId, visibility.actor, visibility.privateAssignedChats)) {
      throw new NotFoundException('Conversation not found');
    }
  }

  private async persist(conversation: Conversation): Promise<Conversation> {
    const saved = await this.conversations.save(conversation);
    this.events?.emitConversationUpdated(saved.sessionId, saved);
    return saved;
  }

  /**
   * A conversation is addressed by its own id, which carries no session segment, so the guard's
   * route-param fence cannot reach it. Every write re-checks the row's session against the calling
   * key here — 403 rather than 404 because the caller already holds a valid id.
   */
  private assertSessionAllowed(sessionId: string, allowedSessions?: string[] | null): void {
    if (allowedSessions == null || allowedSessions.length === 0) return;
    if (!allowedSessions.includes(sessionId)) {
      throw new ForbiddenException('This conversation belongs to a session outside the key scope');
    }
  }

  private resolveScope(requested: string[] | undefined, allowedSessions?: string[] | null): string[] | null {
    if (!requested?.length) return resolveSessionScope(allowedSessions);
    const scoped = allowedSessions != null && allowedSessions.length > 0;
    return scoped ? requested.filter(id => allowedSessions.includes(id)) : requested;
  }
}

function resolveAssignmentAction(
  previous: string | null,
  next: string | null | undefined,
  teamChanged: boolean,
  actor: string | null,
): AssignmentHistory['action'] {
  if (next === null || next === undefined) return teamChanged ? 'team_assigned' : 'unassigned';
  if (previous && previous !== next) return 'reassigned';
  // Assigning yourself is a claim — worth distinguishing in the trail from a lead handing work out.
  if (!previous && actor && next === actor) return 'claimed';
  return 'assigned';
}

function toDate(timestampSeconds: number | undefined): Date {
  if (typeof timestampSeconds !== 'number' || !Number.isFinite(timestampSeconds)) return new Date();
  // Engines report seconds; a value already in milliseconds would land in the year 56000, so treat
  // anything past a plausible seconds range as milliseconds rather than producing a nonsense date.
  const ms = timestampSeconds > 1e11 ? timestampSeconds : timestampSeconds * 1000;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}
