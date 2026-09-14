import { useMemo, useState } from 'react';
import { ArrowRightLeft, Loader2, Sparkles, X } from 'lucide-react';
import type { Agent, AgentPresence, Conversation, Team } from '../../services/commandCenter';
import { Avatar } from '../cc/Primitives';

interface TransferDialogProps {
  conversation: Conversation;
  agents: Agent[];
  teams: Team[];
  /** Live roster, so the picker can show who is actually able to pick this up right now. */
  online: AgentPresence[];
  currentAgentId: string | null;
  transferring: boolean;
  onTransfer: (input: { toAgentId: string; toTeamId?: string | null; note: string }) => void;
  onClose: () => void;
}

/**
 * Hand a conversation to a colleague.
 *
 * The picker leads with who is online, because the point of a transfer is that someone else picks
 * it up NOW — handing a live conversation to an agent who went home is the failure this dialog
 * exists to prevent, so availability is shown rather than left to the sender's memory.
 *
 * The note is prompted for rather than optional-by-omission: the outgoing agent knows things the
 * incoming one does not, and that context is lost the moment they close the tab.
 */
export function TransferDialog({
  conversation,
  agents,
  teams,
  online,
  currentAgentId,
  transferring,
  onTransfer,
  onClose,
}: TransferDialogProps) {
  const [toAgentId, setToAgentId] = useState('');
  const [toTeamId, setToTeamId] = useState(conversation.teamId ?? '');
  const [note, setNote] = useState('');

  const onlineIds = useMemo(() => new Set(online.map(p => p.agentId)), [online]);
  const busyIds = useMemo(
    () => new Set(online.filter(p => p.viewingConversationId).map(p => p.agentId)),
    [online],
  );

  // Available first, then online-but-busy, then everyone else — the order someone actually picks in.
  const candidates = useMemo(
    () =>
      agents
        .filter(agent => agent.active && agent.id !== currentAgentId)
        .sort((a, b) => {
          const rank = (id: string) => (onlineIds.has(id) ? (busyIds.has(id) ? 1 : 0) : 2);
          return rank(a.id) - rank(b.id) || a.name.localeCompare(b.name);
        }),
    [agents, currentAgentId, onlineIds, busyIds],
  );

  return (
    <div className="cc-modal-backdrop" role="dialog" aria-modal="true" aria-label="Transfer conversation" onClick={onClose}>
      <div className="cc-card cc-modal" onClick={event => event.stopPropagation()}>
        <div className="cc-card-head">
          <h2 className="cc-card-title">
            <ArrowRightLeft size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
            Hand over this conversation
          </h2>
          <button type="button" className="cc-btn cc-btn-ghost cc-btn-icon" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="cc-card-body">
          <p className="cc-hint" style={{ marginTop: 0 }}>
            The new owner gets an AI briefing on what has been said and promised, so they can pick the
            thread up without asking {conversation.chatName || 'the customer'} to repeat anything.
          </p>

          <p className="cc-label" style={{ marginTop: '1rem' }}>
            Hand to
          </p>
          {candidates.length === 0 ? (
            <p className="cc-hint" style={{ marginTop: 0 }}>
              There is nobody else to hand this to yet. Add teammates on the Team page.
            </p>
          ) : (
            <ul className="inbox-transfer-list">
              {candidates.map(agent => {
                const isOnline = onlineIds.has(agent.id);
                const isBusy = busyIds.has(agent.id);
                return (
                  <li key={agent.id}>
                    <button
                      type="button"
                      className={`inbox-transfer-option ${toAgentId === agent.id ? 'is-selected' : ''}`}
                      onClick={() => setToAgentId(agent.id)}
                    >
                      <Avatar name={agent.name} seed={agent.id} size="sm" />
                      <span className="inbox-transfer-name cc-truncate">{agent.name}</span>
                      <span className={`inbox-transfer-state ${isOnline ? (isBusy ? 'is-busy' : 'is-free') : 'is-off'}`}>
                        {isOnline ? (isBusy ? 'in a conversation' : 'available') : 'offline'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {teams.length > 0 && (
            <label className="cc-field" style={{ marginTop: '0.9rem' }}>
              <span>Also route to team</span>
              <select className="cc-select" value={toTeamId} onChange={event => setToTeamId(event.target.value)}>
                <option value="">Leave unchanged</option>
                {teams.map(team => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="cc-field">
            <span>What should they know?</span>
            <textarea
              className="cc-textarea"
              rows={3}
              placeholder="e.g. Promised a revised quote today. Customer is annoyed about the last delay."
              value={note}
              onChange={event => setNote(event.target.value)}
            />
            <p className="cc-hint">
              Saved to the conversation notes and the ownership trail. Never sent to WhatsApp.
            </p>
          </label>

          <div className="cc-row" style={{ gap: '0.4rem' }}>
            <button
              type="button"
              className="cc-btn cc-btn-primary"
              disabled={!toAgentId || transferring}
              onClick={() => onTransfer({ toAgentId, toTeamId: toTeamId || null, note })}
            >
              {transferring ? <Loader2 size={13} className="cc-spin" /> : <Sparkles size={13} />}
              Hand over
            </button>
            <button type="button" className="cc-btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default TransferDialog;
