import { Injectable, OnModuleDestroy } from '@nestjs/common';

/** One agent's live state, as the team view and the router both read it. */
export interface AgentPresence {
  agentId: string;
  name: string;
  color: string;
  /** Epoch ms of the last heartbeat. */
  lastSeen: number;
  /** Conversation the agent currently has open, when they have one. */
  viewingConversationId: string | null;
  /** True while the agent is typing into that conversation. */
  typing: boolean;
}

/** Another agent looking at the same conversation, as the inbox renders it. */
export interface ConversationViewer {
  agentId: string;
  name: string;
  color: string;
  typing: boolean;
}

/**
 * How long a heartbeat keeps an agent online. The dashboard beats every 20s, so this tolerates two
 * missed beats before an agent drops off — long enough to survive a brief network stall, short
 * enough that a closed laptop stops receiving routed work within half a minute.
 */
const ONLINE_TTL_MS = 60_000;

/** Typing decays on its own: a browser that closes mid-compose must not leave a stuck indicator. */
const TYPING_TTL_MS = 8_000;

/**
 * Live agent presence and per-conversation viewers.
 *
 * Deliberately in-memory. This is ephemeral state measured in seconds — persisting it would mean a
 * write per heartbeat per agent (100 agents = 5 writes/second of pure churn) to store something
 * that is wrong the moment the process dies. The durable facts already live in `cc_agents`
 * (`lastSeenAt`) and `cc_conversations` (`assigneeId`).
 *
 * SINGLE-NODE scope, and that is a real limit: with several gateway replicas each holds its own
 * view, so the router would only balance across agents connected to the same node. The socket layer
 * already has a Redis adapter for cross-node fan-out; making presence cluster-wide means moving
 * this map to Redis, which is a deliberate next step rather than an accident.
 */
@Injectable()
export class PresenceService implements OnModuleDestroy {
  private readonly agents = new Map<string, AgentPresence>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor() {
    // Expire stale entries even when nobody asks. Without it a crashed browser stays "online"
    // forever in the team view, and the router keeps handing it work nobody will pick up.
    this.sweeper = setInterval(() => this.sweep(), 30_000);
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    clearInterval(this.sweeper);
  }

  /**
   * Record a heartbeat. Returns the agent's presence so the caller can broadcast it.
   *
   * `viewingConversationId` is part of the beat rather than a separate call: the two always change
   * together, and one round trip per 20 seconds per agent is the entire cost of this feature.
   */
  heartbeat(input: {
    agentId: string;
    name: string;
    color: string;
    viewingConversationId?: string | null;
    typing?: boolean;
  }): AgentPresence {
    const now = Date.now();
    const previous = this.agents.get(input.agentId);
    const presence: AgentPresence = {
      agentId: input.agentId,
      name: input.name,
      color: input.color,
      lastSeen: now,
      viewingConversationId: input.viewingConversationId ?? null,
      // Typing is only true while it is being actively re-asserted; a beat that does not claim it
      // clears it, and the TTL below covers a browser that stops beating mid-compose.
      typing: input.typing === true,
    };
    if (previous?.typing && !presence.typing && now - previous.lastSeen < TYPING_TTL_MS) {
      // Keep a very recent typing flag through one beat that omitted it, so the indicator does not
      // flicker between keystrokes.
      presence.typing = previous.viewingConversationId === presence.viewingConversationId;
    }
    this.agents.set(input.agentId, presence);
    return presence;
  }

  /** Drop an agent immediately, e.g. on sign-out or when the tab closes. */
  release(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Everyone currently online, ordered by name.
   *
   * Alphabetical rather than by recency on purpose: every agent re-beats every 20 seconds, so a
   * recency sort would reshuffle the roster continuously — with a hundred agents the presence strip
   * would never sit still long enough to read, and the person you were looking for would move under
   * the cursor. Offline agents are swept out entirely, so "how recently" carries no information
   * about anyone still in this list.
   */
  online(): AgentPresence[] {
    this.sweep();
    return [...this.agents.values()].sort((a, b) => a.name.localeCompare(b.name) || a.agentId.localeCompare(b.agentId));
  }

  /** True when this agent has beaten recently enough to be handed work. */
  isOnline(agentId: string): boolean {
    const presence = this.agents.get(agentId);
    return presence !== undefined && Date.now() - presence.lastSeen < ONLINE_TTL_MS;
  }

  /**
   * Who else is looking at this conversation.
   *
   * `exceptAgentId` omits the caller: an agent does not need telling that they are viewing the
   * conversation they are viewing, and including them would make every conversation appear
   * contended.
   */
  viewersOf(conversationId: string, exceptAgentId?: string | null): ConversationViewer[] {
    this.sweep();
    return [...this.agents.values()]
      .filter(p => p.viewingConversationId === conversationId && p.agentId !== exceptAgentId)
      .map(p => ({ agentId: p.agentId, name: p.name, color: p.color, typing: p.typing }));
  }

  /** Open-conversation viewers keyed by conversation, for the live operations view. */
  viewerCounts(): Map<string, number> {
    this.sweep();
    const counts = new Map<string, number>();
    for (const presence of this.agents.values()) {
      if (!presence.viewingConversationId) continue;
      counts.set(presence.viewingConversationId, (counts.get(presence.viewingConversationId) ?? 0) + 1);
    }
    return counts;
  }

  /** Remove entries whose heartbeat has lapsed, and expire stale typing flags. */
  private sweep(): void {
    const now = Date.now();
    for (const [agentId, presence] of this.agents) {
      if (now - presence.lastSeen >= ONLINE_TTL_MS) {
        this.agents.delete(agentId);
      } else if (presence.typing && now - presence.lastSeen >= TYPING_TTL_MS) {
        presence.typing = false;
      }
    }
  }
}
