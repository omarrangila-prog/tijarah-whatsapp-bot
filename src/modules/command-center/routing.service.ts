import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Not, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { Agent } from './entities/agent.entity';
import { TeamMember } from './entities/team-member.entity';
import { Conversation, ConversationStatus } from './entities/conversation.entity';
import { RoutingStrategy, WorkspaceSettings } from './entities/workspace-settings.entity';
import { PresenceService } from './presence.service';

/** Why a conversation was, or was not, auto-assigned. Recorded so routing is explainable. */
export interface RoutingDecision {
  assignedTo: string | null;
  reason: 'assigned' | 'strategy_manual' | 'already_assigned' | 'no_candidates' | 'all_at_capacity' | 'nobody_online';
}

const SETTINGS_ID = 'default';

/**
 * Distributes inbound conversations across agents.
 *
 * Runs on the recorder's at-most-once inbound path, and only for a conversation that has no owner —
 * so an agent who has already claimed something never has it taken away, and a reply from the
 * customer does not reshuffle work mid-thread.
 *
 * Every refusal is a named reason rather than a silent no-op: "why did this not get assigned" is
 * the question a supervisor asks first, and the honest answers (nobody online, everyone at their
 * ceiling) are exactly the ones that need surfacing.
 */
const SETTINGS_CACHE_MS = 5_000;

@Injectable()
export class RoutingService {
  private readonly logger = createLogger('RoutingService');

  /** Cursor for round-robin. Per-process, and deliberately not persisted: fairness over a shift
   *  does not require surviving a restart, and a stored cursor would serialise every assignment. */
  private roundRobinCursor = 0;

  /** Short-lived settings cache; see getSettings. */
  private settingsCache: WorkspaceSettings | null = null;
  private settingsCacheExpiry = 0;

  /** Drop the cached settings row so the next read reloads it. */
  invalidateSettingsCache(): void {
    this.settingsCache = null;
    this.settingsCacheExpiry = 0;
  }

  constructor(
    @InjectRepository(WorkspaceSettings, 'data') private readonly settings: Repository<WorkspaceSettings>,
    @InjectRepository(Agent, 'data') private readonly agents: Repository<Agent>,
    @InjectRepository(TeamMember, 'data') private readonly members: Repository<TeamMember>,
    @InjectRepository(Conversation, 'data') private readonly conversations: Repository<Conversation>,
    private readonly presence: PresenceService,
  ) {}

  /**
   * Read the workspace settings, creating the single row on first use.
   *
   * Cached for a few seconds because the privacy fence consults these settings on every
   * conversation read — without a cache, enabling private chats would add a database round-trip to
   * every request in the busiest endpoint in the product. The TTL is short enough that a
   * supervisor's change is felt immediately in practice, and `updateSettings` clears it outright so
   * the writer never observes its own stale value.
   */
  async getSettings(): Promise<WorkspaceSettings> {
    const now = Date.now();
    if (this.settingsCache && now < this.settingsCacheExpiry) return this.settingsCache;

    const existing = await this.settings.findOne({ where: { id: SETTINGS_ID } });
    const row =
      existing ??
      (await this.settings.save(
        this.settings.create({
          id: SETTINGS_ID,
          routingStrategy: RoutingStrategy.MANUAL,
          routingTeamId: null,
          routeToOnlineOnly: true,
          maxOpenPerAgent: 0,
          presenceTimeoutMinutes: 5,
          privateAssignedChats: false,
        }),
      ));

    this.settingsCache = row;
    this.settingsCacheExpiry = now + SETTINGS_CACHE_MS;
    return row;
  }

  async updateSettings(patch: Partial<WorkspaceSettings>): Promise<WorkspaceSettings> {
    const current = await this.getSettings();
    if (patch.routingStrategy !== undefined) current.routingStrategy = patch.routingStrategy;
    if (patch.routingTeamId !== undefined) current.routingTeamId = patch.routingTeamId;
    if (patch.routeToOnlineOnly !== undefined) current.routeToOnlineOnly = patch.routeToOnlineOnly;
    if (patch.maxOpenPerAgent !== undefined) current.maxOpenPerAgent = Math.max(0, patch.maxOpenPerAgent);
    if (patch.presenceTimeoutMinutes !== undefined) {
      current.presenceTimeoutMinutes = Math.max(1, patch.presenceTimeoutMinutes);
    }
    if (patch.privateAssignedChats !== undefined) current.privateAssignedChats = patch.privateAssignedChats;
    const saved = await this.settings.save(current);
    this.invalidateSettingsCache();
    return saved;
  }

  /**
   * Choose an owner for a freshly-active conversation.
   *
   * Returns the decision rather than performing the assignment: the caller already holds the
   * conversation and does the write, which keeps this service free of the emit/history side effects
   * that belong with the assignment itself.
   */
  async route(conversation: Conversation): Promise<RoutingDecision> {
    if (conversation.assigneeId) return { assignedTo: null, reason: 'already_assigned' };

    const settings = await this.getSettings();
    if (settings.routingStrategy === RoutingStrategy.MANUAL) {
      return { assignedTo: null, reason: 'strategy_manual' };
    }

    const candidates = await this.candidateAgents(settings);
    if (candidates.length === 0) {
      return { assignedTo: null, reason: settings.routeToOnlineOnly ? 'nobody_online' : 'no_candidates' };
    }

    const load = await this.openCountsFor(candidates.map(agent => agent.id));
    const withCapacity =
      settings.maxOpenPerAgent > 0
        ? candidates.filter(agent => (load.get(agent.id) ?? 0) < settings.maxOpenPerAgent)
        : candidates;

    if (withCapacity.length === 0) return { assignedTo: null, reason: 'all_at_capacity' };

    const chosen =
      settings.routingStrategy === RoutingStrategy.LEAST_BUSY
        ? pickLeastBusy(withCapacity, load)
        : this.pickRoundRobin(withCapacity);

    this.logger.debug('Routed conversation', {
      conversationId: conversation.id,
      agentId: chosen.id,
      strategy: settings.routingStrategy,
    });
    return { assignedTo: chosen.id, reason: 'assigned' };
  }

  /**
   * Distribute the conversations already waiting in the queue.
   *
   * Routing otherwise only fires when a new message arrives, which leaves a real gap: a supervisor
   * who switches to round-robin mid-shift has a backlog of unowned conversations that nobody is
   * assigned to and that no future event will touch — the setting appears to do nothing until the
   * next customer writes in. This applies the current strategy to that backlog on demand.
   *
   * Bounded by `limit` so one call cannot walk an unbounded queue, and it re-reads capacity per
   * conversation so a burst respects `maxOpenPerAgent` instead of handing one agent the lot.
   */
  async distributeQueue(limit = 50): Promise<{
    assigned: Array<{ conversationId: string; agentId: string }>;
    skipped: number;
    reason: RoutingDecision['reason'] | null;
  }> {
    const settings = await this.getSettings();
    if (settings.routingStrategy === RoutingStrategy.MANUAL) {
      return { assigned: [], skipped: 0, reason: 'strategy_manual' };
    }

    const waiting = await this.conversations.find({
      where: { assigneeId: IsNull(), status: Not(ConversationStatus.RESOLVED) },
      order: { lastMessageAt: 'ASC' },
      take: Math.min(Math.max(limit, 1), 200),
    });

    const assigned: Array<{ conversationId: string; agentId: string }> = [];
    let skipped = 0;
    let lastReason: RoutingDecision['reason'] | null = null;

    for (const conversation of waiting) {
      const decision = await this.route(conversation);
      if (decision.assignedTo) {
        // Written here rather than returned, because the caller is distributing a whole queue and
        // each decision must be visible to the NEXT one — least-busy is meaningless otherwise.
        conversation.assigneeId = decision.assignedTo;
        await this.conversations.save(conversation);
        assigned.push({ conversationId: conversation.id, agentId: decision.assignedTo });
      } else {
        skipped += 1;
        lastReason = decision.reason;
      }
    }

    this.logger.log('Distributed the waiting queue', {
      strategy: settings.routingStrategy,
      assigned: assigned.length,
      skipped,
    });
    return { assigned, skipped, reason: lastReason };
  }

  /** Active agents eligible for work, honouring the team restriction and the online-only rule. */
  private async candidateAgents(settings: WorkspaceSettings): Promise<Agent[]> {
    let agents: Agent[];
    if (settings.routingTeamId) {
      const memberships = await this.members.find({ where: { teamId: settings.routingTeamId } });
      if (memberships.length === 0) return [];
      agents = await this.agents.find({
        where: { id: In(memberships.map(m => m.agentId)), active: true },
        order: { id: 'ASC' },
      });
    } else {
      agents = await this.agents.find({ where: { active: true }, order: { id: 'ASC' } });
    }
    if (!settings.routeToOnlineOnly) return agents;
    return agents.filter(agent => this.presence.isOnline(agent.id));
  }

  /** How many unresolved conversations each candidate currently holds. */
  private async openCountsFor(agentIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>(agentIds.map(id => [id, 0]));
    if (agentIds.length === 0) return counts;
    const rows = await this.conversations
      .createQueryBuilder('c')
      .select('c.assigneeId', 'assigneeId')
      .addSelect('COUNT(*)', 'total')
      .where('c.assigneeId IN (:...agentIds)', { agentIds })
      .andWhere('c.status != :resolved', { resolved: ConversationStatus.RESOLVED })
      .groupBy('c.assigneeId')
      .getRawMany<{ assigneeId: string; total: string | number }>();
    for (const row of rows) counts.set(row.assigneeId, Number(row.total));
    return counts;
  }

  /**
   * Next agent in turn.
   *
   * The cursor advances over the CANDIDATE list, whose length changes as people come and go, so it
   * is taken modulo the current length on every call rather than reset — resetting would send a
   * burst of conversations to whoever sorts first every time someone logged in.
   */
  private pickRoundRobin(candidates: Agent[]): Agent {
    const chosen = candidates[this.roundRobinCursor % candidates.length];
    this.roundRobinCursor = (this.roundRobinCursor + 1) % Number.MAX_SAFE_INTEGER;
    return chosen;
  }
}

/**
 * The candidate holding the fewest open conversations.
 *
 * Ties break on agent id rather than arbitrarily, so the choice is deterministic and a test can
 * assert it — an unstable tiebreak makes an unfair distribution impossible to reproduce.
 */
export function pickLeastBusy(candidates: Agent[], load: Map<string, number>): Agent {
  return [...candidates].sort((a, b) => {
    const diff = (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  })[0];
}
