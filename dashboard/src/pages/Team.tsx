import { useMemo, useState } from 'react';
import { Key, Link2, Loader2, Plus, Share2, Shuffle, Trash2, UserCog, Users } from 'lucide-react';
import {
  useAgentMutations,
  useAgentsQuery,
  useCurrentActorQuery,
  usePresenceRosterQuery,
  useRoutingMutations,
  useRoutingQuery,
  useTeamMutations,
  useTeamsQuery,
} from '../hooks/commandCenter';
import { useApiKeysQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { Avatar, EmptyState, ErrorState, Skeleton } from '../components/cc/Primitives';
import { relativeTime } from '../utils/ccFormat';
import type { RoutingStrategy } from '../services/commandCenter';
import './Team.css';

const AGENT_COLORS = ['#25d366', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#65a30d'];

/**
 * Team management.
 *
 * The gateway authenticates with API keys, not user accounts, so an "agent" is the person an API key
 * acts as. Linking a key to an agent is what makes Mine, Claim and assignment attribution work —
 * the page says so, because otherwise an operator would create agents and wonder why nothing
 * changed in the inbox.
 */
export function Team() {
  useDocumentTitle('Team');
  const { success, error: showError } = useToast();
  const { canWrite, role } = useRole();

  const agentsQuery = useAgentsQuery();
  const teamsQuery = useTeamsQuery();
  const actorQuery = useCurrentActorQuery();
  // Admins can link an agent to a key; everyone else sees the agent list without the key column.
  const apiKeysQuery = useApiKeysQuery(role === 'admin');
  const agentMutations = useAgentMutations();
  const teamMutations = useTeamMutations();
  const routingQuery = useRoutingQuery();
  const routingMutations = useRoutingMutations();
  const rosterQuery = usePresenceRosterQuery();

  const [agentDraft, setAgentDraft] = useState<{ id: string | null; name: string; email: string; apiKeyId: string; color: string } | null>(null);
  const [teamDraft, setTeamDraft] = useState<{ id: string | null; name: string; description: string; color: string } | null>(null);

  const agents = useMemo(() => agentsQuery.data ?? [], [agentsQuery.data]);
  const teams = useMemo(() => teamsQuery.data ?? [], [teamsQuery.data]);
  const currentAgentId = actorQuery.data?.agent?.id ?? null;
  const online = useMemo(() => rosterQuery.data?.online ?? [], [rosterQuery.data]);
  const onlineIds = useMemo(() => new Set(online.map(p => p.agentId)), [online]);
  const routing = routingQuery.data;
  const linkedKeyIds = useMemo(() => new Set(agents.map(agent => agent.apiKeyId).filter(Boolean)), [agents]);

  const saveAgent = () => {
    if (!agentDraft) return;
    const payload = {
      name: agentDraft.name.trim(),
      email: agentDraft.email.trim() || undefined,
      apiKeyId: agentDraft.apiKeyId || undefined,
      color: agentDraft.color,
    };
    const handlers = {
      onSuccess: () => {
        success(agentDraft.id ? 'Agent updated' : 'Agent added');
        setAgentDraft(null);
      },
      onError: (error: unknown) => showError(error instanceof Error ? error.message : 'Could not save the agent'),
    };
    if (agentDraft.id) agentMutations.update.mutate({ id: agentDraft.id, ...payload }, handlers);
    else agentMutations.create.mutate(payload, handlers);
  };

  const saveTeam = () => {
    if (!teamDraft) return;
    const payload = { name: teamDraft.name.trim(), description: teamDraft.description.trim() || undefined, color: teamDraft.color };
    const handlers = {
      onSuccess: () => {
        success(teamDraft.id ? 'Team updated' : 'Team created');
        setTeamDraft(null);
      },
      onError: (error: unknown) => showError(error instanceof Error ? error.message : 'Could not save the team'),
    };
    if (teamDraft.id) teamMutations.update.mutate({ id: teamDraft.id, ...payload }, handlers);
    else teamMutations.create.mutate(payload, handlers);
  };

  return (
    <div className="cc-page team">
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">Team</h1>
          <p className="cc-page-sub">
            The people who work your inbox, and the teams conversations route to. Linking an agent to an API key is what
            lets them claim conversations and filter to "Mine".
          </p>
        </div>
      </header>

      {!actorQuery.isLoading && !currentAgentId && (
        <div className="cc-card team-notice">
          <div className="cc-card-body cc-row" style={{ gap: '0.6rem' }}>
            <Link2 size={17} />
            <div>
              <strong>Your API key is not linked to an agent.</strong>
              <p className="cc-page-sub" style={{ margin: '0.2rem 0 0' }}>
                Create an agent below and link it to <b>{actorQuery.data?.apiKeyName ?? 'your key'}</b> to claim
                conversations and use the "Mine" filter.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ── Work distribution ─────────────────────────────────────── */}
      <section className="cc-card team-routing">
        <div className="cc-card-head">
          <h2 className="cc-card-title">
            <Shuffle size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
            How work is shared
          </h2>
          <span className="team-shift">
            <span className="team-shift-dot" />
            {online.length} on shift
          </span>
        </div>
        <div className="cc-card-body">
          <p className="cc-hint" style={{ marginTop: 0 }}>
            One WhatsApp number, many agents. Choose how an arriving conversation finds an owner — and
            the inbox will warn an agent when a teammate already has the same conversation open.
          </p>

          <div className="team-strategies">
            {(
              [
                ['manual', 'Manual', 'Nothing is assigned automatically. Agents claim from the shared queue.'],
                ['round_robin', 'Round robin', 'Each new conversation goes to the next agent in turn. Even and predictable.'],
                ['least_busy', 'Least busy', 'Each new conversation goes to whoever currently holds the fewest open ones.'],
              ] as const
            ).map(([value, label, blurb]) => (
              <button
                key={value}
                type="button"
                className={`team-strategy ${routing?.routingStrategy === value ? 'is-active' : ''}`}
                disabled={role !== 'admin' || routingMutations.update.isPending}
                onClick={() =>
                  routingMutations.update.mutate(
                    { routingStrategy: value as RoutingStrategy },
                    { onSuccess: () => success(`Work distribution set to ${label.toLowerCase()}`) },
                  )
                }
              >
                <strong>{label}</strong>
                <span>{blurb}</span>
              </button>
            ))}
          </div>

          {routing && routing.routingStrategy !== 'manual' && (
            <div className="team-routing-opts">
              <label className="cc-row" style={{ gap: '0.4rem' }}>
                <input
                  type="checkbox"
                  checked={routing.routeToOnlineOnly}
                  disabled={role !== 'admin'}
                  onChange={event => routingMutations.update.mutate({ routeToOnlineOnly: event.target.checked })}
                />
                <span>Only assign to agents who are online</span>
              </label>
              <label className="cc-row" style={{ gap: '0.4rem' }}>
                <span>Max open per agent</span>
                <input
                  className="cc-input"
                  type="number"
                  min={0}
                  max={500}
                  style={{ width: 82 }}
                  defaultValue={routing.maxOpenPerAgent}
                  disabled={role !== 'admin'}
                  onBlur={event => {
                    const next = Number(event.target.value);
                    if (next !== routing.maxOpenPerAgent) routingMutations.update.mutate({ maxOpenPerAgent: next });
                  }}
                />
                <span className="cc-hint" style={{ margin: 0 }}>
                  0 = no ceiling
                </span>
              </label>
              <button
                type="button"
                className="cc-btn cc-btn-sm"
                disabled={!canWrite || routingMutations.distribute.isPending}
                onClick={() =>
                  routingMutations.distribute.mutate(50, {
                    onSuccess: result =>
                      result.assigned > 0
                        ? success(`Shared out ${result.assigned} conversation${result.assigned === 1 ? '' : 's'}`)
                        : showError(
                            'Nothing was assigned',
                            result.reason === 'nobody_online'
                              ? 'No agent is online. Turn off the online-only rule, or ask the team to sign in.'
                              : result.reason === 'all_at_capacity'
                                ? 'Every agent is at their open-conversation ceiling.'
                                : 'There is nothing waiting in the queue.',
                          ),
                  })
                }
                title="Apply the current strategy to conversations that are already waiting"
              >
                {routingMutations.distribute.isPending ? <Loader2 size={13} className="cc-spin" /> : <Share2 size={13} />}
                Share out the waiting queue
              </button>
              <p className="cc-hint" style={{ marginTop: 0 }}>
                Routing runs when a message arrives. Use this once after changing the strategy, to
                distribute conversations that were already waiting.
              </p>
            </div>
          )}

          {/* Privacy applies whatever the routing strategy is: a manual workspace still has agents
              who should not be reading each other's customer conversations. */}
          <label className="cc-row team-privacy" style={{ gap: '0.4rem' }}>
            <input
              type="checkbox"
              checked={routing?.privateAssignedChats ?? false}
              disabled={role !== 'admin'}
              onChange={event => routingMutations.update.mutate({ privateAssignedChats: event.target.checked })}
            />
            <span>Private chats — each agent sees only their own conversations</span>
          </label>
          <p className="cc-hint" style={{ marginTop: 0 }}>
            {routing?.privateAssignedChats
              ? 'Agents see the unassigned queue plus whatever is assigned to them. Admins still see everything.'
              : 'Everyone can currently see every conversation on this number.'}
          </p>
        </div>
      </section>

      <div className="team-layout">
        {/* ── Agents ─────────────────────────────────────────────── */}
        <section className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">
              <UserCog size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
              Agents
            </h2>
            <button
              type="button"
              className="cc-btn cc-btn-sm"
              onClick={() => setAgentDraft({ id: null, name: '', email: '', apiKeyId: '', color: AGENT_COLORS[agents.length % AGENT_COLORS.length] })}
              disabled={role !== 'admin'}
              title={role !== 'admin' ? 'Only an admin can manage agents' : undefined}
            >
              <Plus size={12} /> Add agent
            </button>
          </div>

          {agentDraft && (
            <div className="team-form">
              <div className="team-form-grid">
                <label className="cc-field">
                  <span>Name</span>
                  <input className="cc-input" value={agentDraft.name} onChange={event => setAgentDraft({ ...agentDraft, name: event.target.value })} autoFocus />
                </label>
                <label className="cc-field">
                  <span>Email</span>
                  <input className="cc-input" type="email" value={agentDraft.email} onChange={event => setAgentDraft({ ...agentDraft, email: event.target.value })} />
                </label>
                <label className="cc-field">
                  <span>Linked API key</span>
                  <select className="cc-select" value={agentDraft.apiKeyId} onChange={event => setAgentDraft({ ...agentDraft, apiKeyId: event.target.value })}>
                    <option value="">Not linked</option>
                    {(apiKeysQuery.data ?? []).map(key => (
                      <option key={key.id} value={key.id} disabled={linkedKeyIds.has(key.id) && key.id !== agentDraft.apiKeyId}>
                        {key.name} ({key.keyPrefix}…){linkedKeyIds.has(key.id) && key.id !== agentDraft.apiKeyId ? ' — already linked' : ''}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="cc-field">
                  <span>Colour</span>
                  <div className="cc-swatch-row">
                    {AGENT_COLORS.map(color => (
                      <button
                        key={color}
                        type="button"
                        className={`cc-swatch-btn ${agentDraft.color === color ? 'is-active' : ''}`}
                        style={{ background: color }}
                        onClick={() => setAgentDraft({ ...agentDraft, color })}
                        aria-label={`Use colour ${color}`}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="cc-row" style={{ gap: '0.4rem' }}>
                <button type="button" className="cc-btn cc-btn-primary cc-btn-sm" onClick={saveAgent} disabled={!agentDraft.name.trim() || agentMutations.create.isPending}>
                  {agentMutations.create.isPending || agentMutations.update.isPending ? <Loader2 size={12} className="cc-spin" /> : null}
                  {agentDraft.id ? 'Save' : 'Add agent'}
                </button>
                <button type="button" className="cc-btn cc-btn-sm" onClick={() => setAgentDraft(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="cc-card-body" style={{ padding: 0 }}>
            {agentsQuery.isLoading ? (
              <div style={{ padding: '1rem' }}>
                <Skeleton height={48} />
              </div>
            ) : agentsQuery.error ? (
              <div style={{ padding: '1rem' }}>
                <ErrorState error={agentsQuery.error} onRetry={() => void agentsQuery.refetch()} />
              </div>
            ) : agents.length === 0 ? (
              <EmptyState icon={<UserCog size={20} />} title="No agents yet" description="Add the people who will work your inbox." />
            ) : (
              <ul className="team-rows">
                {agents.map(agent => (
                  <li key={agent.id}>
                    <span className="team-avatar-wrap">
                      <span className="cc-avatar cc-avatar-sm" style={{ background: agent.color }}>
                        {agent.name.slice(0, 1).toUpperCase()}
                      </span>
                      {onlineIds.has(agent.id) && <span className="team-online-dot" title="Online now" />}
                    </span>
                    <span className="team-row-main">
                      <span className="team-row-name cc-truncate">
                        {agent.name}
                        {agent.id === currentAgentId && <span className="cc-chip cc-chip-neutral team-you">you</span>}
                      </span>
                      <span className="team-row-sub cc-truncate">{agent.email || 'No email'}</span>
                    </span>
                    {agent.apiKeyId ? (
                      <span className="cc-chip cc-chip-resolved" title="Signed in with a linked API key">
                        <Key size={10} /> linked
                      </span>
                    ) : (
                      <span className="cc-chip cc-chip-neutral" title="Cannot claim conversations until a key is linked">
                        not linked
                      </span>
                    )}
                    <span className="team-row-seen">
                      {onlineIds.has(agent.id) ? 'online' : agent.lastSeenAt ? relativeTime(agent.lastSeenAt) : 'never'}
                    </span>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() =>
                        setAgentDraft({ id: agent.id, name: agent.name, email: agent.email ?? '', apiKeyId: agent.apiKeyId ?? '', color: agent.color })
                      }
                      disabled={role !== 'admin'}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() => {
                        if (window.confirm(`Remove ${agent.name}? Their conversations stay put but become unowned.`)) {
                          agentMutations.remove.mutate(agent.id, { onSuccess: () => success('Agent removed') });
                        }
                      }}
                      disabled={role !== 'admin'}
                      aria-label={`Remove ${agent.name}`}
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ── Teams ──────────────────────────────────────────────── */}
        <section className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">
              <Users size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
              Teams
            </h2>
            <button
              type="button"
              className="cc-btn cc-btn-sm"
              onClick={() => setTeamDraft({ id: null, name: '', description: '', color: '#2563eb' })}
              disabled={role !== 'admin'}
            >
              <Plus size={12} /> New team
            </button>
          </div>

          {teamDraft && (
            <div className="team-form">
              <div className="team-form-grid">
                <label className="cc-field">
                  <span>Name</span>
                  <input className="cc-input" value={teamDraft.name} onChange={event => setTeamDraft({ ...teamDraft, name: event.target.value })} autoFocus />
                </label>
                <label className="cc-field">
                  <span>Description</span>
                  <input className="cc-input" value={teamDraft.description} onChange={event => setTeamDraft({ ...teamDraft, description: event.target.value })} />
                </label>
              </div>
              <div className="cc-row" style={{ gap: '0.4rem' }}>
                <button type="button" className="cc-btn cc-btn-primary cc-btn-sm" onClick={saveTeam} disabled={!teamDraft.name.trim()}>
                  {teamDraft.id ? 'Save' : 'Create team'}
                </button>
                <button type="button" className="cc-btn cc-btn-sm" onClick={() => setTeamDraft(null)}>
                  Cancel
                </button>
              </div>
            </div>
          )}

          <div className="cc-card-body" style={{ padding: 0 }}>
            {teamsQuery.isLoading ? (
              <div style={{ padding: '1rem' }}>
                <Skeleton height={48} />
              </div>
            ) : teams.length === 0 ? (
              <EmptyState icon={<Users size={20} />} title="No teams yet" description="Create teams like Sales or Support to route conversations to a group rather than one person." />
            ) : (
              <ul className="team-cards">
                {teams.map(team => (
                  <li key={team.id} className="team-card">
                    <div className="team-card-head">
                      <span className="team-swatch" style={{ background: team.color }} />
                      <span className="team-card-name cc-truncate">{team.name}</span>
                      <span className="cc-chip cc-chip-neutral cc-num">{team.members.length}</span>
                      <button
                        type="button"
                        className="cc-btn cc-btn-ghost cc-btn-sm"
                        onClick={() => setTeamDraft({ id: team.id, name: team.name, description: team.description ?? '', color: team.color })}
                        disabled={role !== 'admin'}
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        className="cc-btn cc-btn-ghost cc-btn-sm"
                        onClick={() => {
                          if (window.confirm(`Delete the ${team.name} team?`)) {
                            teamMutations.remove.mutate(team.id, { onSuccess: () => success('Team deleted') });
                          }
                        }}
                        disabled={role !== 'admin'}
                        aria-label={`Delete ${team.name}`}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {team.description && <p className="team-card-desc">{team.description}</p>}

                    <div className="team-members">
                      {team.members.map(member => (
                        <span key={member.agentId} className="team-member">
                          <Avatar name={member.name} seed={member.agentId} size="sm" />
                          {member.name}
                          {canWrite && (
                            <button
                              type="button"
                              onClick={() => teamMutations.removeMember.mutate({ teamId: team.id, agentId: member.agentId })}
                              aria-label={`Remove ${member.name} from ${team.name}`}
                            >
                              ×
                            </button>
                          )}
                        </span>
                      ))}
                      {agents.filter(agent => !team.members.some(member => member.agentId === agent.id)).length > 0 && canWrite && (
                        <select
                          className="cc-mini-select"
                          value=""
                          onChange={event => {
                            if (event.target.value) {
                              teamMutations.addMember.mutate({ teamId: team.id, agentId: event.target.value });
                            }
                          }}
                          aria-label={`Add a member to ${team.name}`}
                        >
                          <option value="">
                            + Add member
                          </option>
                          {agents
                            .filter(agent => !team.members.some(member => member.agentId === agent.id))
                            .map(agent => (
                              <option key={agent.id} value={agent.id}>
                                {agent.name}
                              </option>
                            ))}
                        </select>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

export default Team;
