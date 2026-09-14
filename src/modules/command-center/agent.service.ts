import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import type { ApiKey } from '../auth/entities/api-key.entity';
import { Agent } from './entities/agent.entity';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';

/** A team plus its resolved members, as the Team page renders it. */
export interface TeamView extends Team {
  members: Array<{ agentId: string; name: string; color: string; teamRole: string }>;
}

/**
 * Agents and teams.
 *
 * An "agent" is the human identity behind an API key. OpenWA has no user table — authentication is
 * key-based — so `resolveActor` is the bridge: it maps the calling key to an agent row, and that is
 * what "Mine", "claim" and assignment attribution are built on. A key with no linked agent still
 * works everywhere; those actions simply fall back to the key's name.
 */
const AGENT_KEY_CACHE_MS = 10_000;

@Injectable()
export class AgentService {
  constructor(
    @InjectRepository(Agent, 'data') private readonly agents: Repository<Agent>,
    @InjectRepository(Team, 'data') private readonly teams: Repository<Team>,
    @InjectRepository(TeamMember, 'data') private readonly members: Repository<TeamMember>,
  ) {}

  /** Agent→API-key map backing the realtime privacy fence; see recipientKeyIds. */
  private keyMapCache: { byAgent: Map<string, string | null>; admins: string[] } | null = null;
  private keyMapCacheExpiry = 0;

  // ----------------------------------------------------------------- agents

  listAgents(): Promise<Agent[]> {
    return this.agents.find({ order: { name: 'ASC' } });
  }

  async getAgent(id: string): Promise<Agent> {
    const agent = await this.agents.findOne({ where: { id } });
    if (!agent) throw new NotFoundException(`Agent ${id} not found`);
    return agent;
  }

  /**
   * The agent the calling key acts as, or null when the key has no linked agent.
   *
   * Also refreshes `lastSeenAt` so the Team page can show who is actually working — fire-and-forget
   * because a presence timestamp must never be able to fail a request.
   */
  /**
   * The API keys that must receive realtime updates about a conversation owned by `assigneeId`.
   *
   * Cached briefly: this runs on the realtime path, once per conversation event, and without a
   * cache a busy floor would issue two queries per emitted event purely to answer a question whose
   * answer changes when someone is hired.
   */
  async recipientKeyIds(
    assigneeId: string | null | undefined,
  ): Promise<{ assigneeKeyId: string | null; adminKeyIds: string[] }> {
    const now = Date.now();
    if (!this.keyMapCache || now >= this.keyMapCacheExpiry) {
      const rows = await this.agents.find({ select: { id: true, apiKeyId: true, role: true } });
      this.keyMapCache = {
        byAgent: new Map(rows.map(r => [r.id, r.apiKeyId])),
        admins: rows.filter(r => r.role === 'admin' && r.apiKeyId).map(r => r.apiKeyId as string),
      };
      this.keyMapCacheExpiry = now + AGENT_KEY_CACHE_MS;
    }
    return {
      assigneeKeyId: assigneeId ? (this.keyMapCache.byAgent.get(assigneeId) ?? null) : null,
      adminKeyIds: this.keyMapCache.admins,
    };
  }

  /** Drop the cached agent→key map; called when agents or their keys change. */
  invalidateKeyMap(): void {
    this.keyMapCache = null;
    this.keyMapCacheExpiry = 0;
  }

  async resolveActor(apiKey?: Pick<ApiKey, 'id'>): Promise<Agent | null> {
    if (!apiKey?.id) return null;
    const agent = await this.agents.findOne({ where: { apiKeyId: apiKey.id } });
    if (agent) {
      void this.agents.update({ id: agent.id }, { lastSeenAt: new Date() }).catch(() => undefined);
    }
    return agent;
  }

  async createAgent(input: Partial<Agent>): Promise<Agent> {
    await this.assertApiKeyFree(input.apiKeyId ?? null, null);
    const agent = this.agents.create({
      name: input.name!,
      email: input.email ?? null,
      apiKeyId: input.apiKeyId ?? null,
      role: input.role ?? 'operator',
      color: input.color ?? '#25d366',
      active: input.active ?? true,
    });
    return this.agents.save(agent);
  }

  async updateAgent(id: string, input: Partial<Agent>): Promise<Agent> {
    const agent = await this.getAgent(id);
    if (input.apiKeyId !== undefined) {
      await this.assertApiKeyFree(input.apiKeyId, id);
      agent.apiKeyId = input.apiKeyId;
    }
    if (input.name !== undefined) agent.name = input.name;
    if (input.email !== undefined) agent.email = input.email;
    if (input.role !== undefined) agent.role = input.role;
    if (input.color !== undefined) agent.color = input.color;
    if (input.active !== undefined) agent.active = input.active;
    return this.agents.save(agent);
  }

  async deleteAgent(id: string): Promise<void> {
    await this.getAgent(id);
    // Memberships are the agent's own rows and go with them. Conversations assigned to the agent
    // are deliberately NOT touched here: the assignment column is a soft reference, so the
    // conversation degrades to "assigned to a removed agent" and stays visible in the inbox rather
    // than disappearing from every filter mid-shift.
    await this.members.delete({ agentId: id });
    await this.agents.delete({ id });
  }

  /**
   * One API key maps to at most one agent — otherwise "who am I" has two answers and `resolveActor`
   * would silently pick whichever row the database returned first.
   */
  private async assertApiKeyFree(apiKeyId: string | null, exceptAgentId: string | null): Promise<void> {
    if (!apiKeyId) return;
    const clash = await this.agents.findOne({
      where: exceptAgentId ? { apiKeyId, id: Not(exceptAgentId) } : { apiKeyId },
    });
    if (clash) throw new ConflictException(`API key is already linked to agent "${clash.name}"`);
  }

  // ------------------------------------------------------------------ teams

  async listTeams(): Promise<TeamView[]> {
    const teams = await this.teams.find({ order: { name: 'ASC' } });
    if (teams.length === 0) return [];
    const links = await this.members.find({ where: { teamId: In(teams.map(t => t.id)) } });
    const agentRows = links.length
      ? await this.agents.find({ where: { id: In([...new Set(links.map(l => l.agentId))]) } })
      : [];
    const agentById = new Map(agentRows.map(a => [a.id, a]));

    return teams.map(team => ({
      ...team,
      members: links
        .filter(link => link.teamId === team.id)
        .map(link => {
          const agent = agentById.get(link.agentId);
          return {
            agentId: link.agentId,
            // A membership whose agent row is gone still shows, labelled — silently dropping it
            // would make the team look smaller than the data says it is.
            name: agent?.name ?? 'Removed agent',
            color: agent?.color ?? '#94a3b8',
            teamRole: link.teamRole,
          };
        }),
    }));
  }

  async createTeam(input: Partial<Team>): Promise<Team> {
    const existing = await this.teams.findOne({ where: { name: input.name! } });
    if (existing) throw new ConflictException(`A team named "${input.name!}" already exists`);
    return this.teams.save(
      this.teams.create({
        name: input.name!,
        description: input.description ?? null,
        color: input.color ?? '#2563eb',
      }),
    );
  }

  async updateTeam(id: string, input: Partial<Team>): Promise<Team> {
    const team = await this.teams.findOne({ where: { id } });
    if (!team) throw new NotFoundException(`Team ${id} not found`);
    if (input.name !== undefined) team.name = input.name;
    if (input.description !== undefined) team.description = input.description;
    if (input.color !== undefined) team.color = input.color;
    return this.teams.save(team);
  }

  async deleteTeam(id: string): Promise<void> {
    const team = await this.teams.findOne({ where: { id } });
    if (!team) throw new NotFoundException(`Team ${id} not found`);
    await this.members.delete({ teamId: id });
    await this.teams.delete({ id });
  }

  async addMember(teamId: string, agentId: string, teamRole: 'lead' | 'member' = 'member'): Promise<TeamMember> {
    const team = await this.teams.findOne({ where: { id: teamId } });
    if (!team) throw new NotFoundException(`Team ${teamId} not found`);
    await this.getAgent(agentId);
    const existing = await this.members.findOne({ where: { teamId, agentId } });
    if (existing) {
      existing.teamRole = teamRole;
      return this.members.save(existing);
    }
    return this.members.save(this.members.create({ teamId, agentId, teamRole }));
  }

  async removeMember(teamId: string, agentId: string): Promise<void> {
    const result = await this.members.delete({ teamId, agentId });
    if (!result.affected) throw new BadRequestException('That agent is not a member of this team');
  }

  /** Team ids the agent belongs to — used by the inbox's "my team" filter. */
  async teamIdsForAgent(agentId: string): Promise<string[]> {
    const links = await this.members.find({ where: { agentId } });
    return links.map(l => l.teamId);
  }
}
