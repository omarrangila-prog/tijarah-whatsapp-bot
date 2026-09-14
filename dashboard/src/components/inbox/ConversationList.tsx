import { Search, X, Filter, Loader2 } from 'lucide-react';
import type { Agent, Conversation, ConversationPriority, ConversationStatus } from '../../services/commandCenter';
import type { Session } from '../../services/api';
import { Avatar, EmptyState, ErrorState, SkeletonList } from '../cc/Primitives';
import { chatKindLabel, formatWaId, relativeTime } from '../../utils/ccFormat';

interface ConversationListProps {
  conversations: Conversation[];
  total: number;
  loading: boolean;
  fetching: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (conversation: Conversation) => void;
  search: string;
  onSearchChange: (value: string) => void;
  agentsById: Map<string, Agent>;
  sessionsById: Map<string, Session>;
  /** Extra filters shown in the drawer under the search box. */
  status: ConversationStatus | '';
  onStatusChange: (value: ConversationStatus | '') => void;
  priority: ConversationPriority | '';
  onPriorityChange: (value: ConversationPriority | '') => void;
  assignee: string;
  onAssigneeChange: (value: string) => void;
  agents: Agent[];
  onLoadMore: () => void;
  canLoadMore: boolean;
}

/**
 * The conversation column.
 *
 * Every card carries the six things an operator triages on — who, which number, what was last said,
 * when, whether it is unread, and who owns it — without wrapping to a second line, because the
 * value of this column is that a dozen conversations fit on screen at once.
 */
export function ConversationList({
  conversations,
  total,
  loading,
  fetching,
  error,
  onRetry,
  selectedId,
  onSelect,
  search,
  onSearchChange,
  agentsById,
  sessionsById,
  status,
  onStatusChange,
  priority,
  onPriorityChange,
  assignee,
  onAssigneeChange,
  agents,
  onLoadMore,
  canLoadMore,
}: ConversationListProps) {
  const hasExtraFilters = Boolean(status || priority || assignee);

  return (
    <section className="inbox-list" aria-label="Conversations">
      <div className="inbox-list-head">
        <div className="cc-search">
          <Search size={15} aria-hidden="true" />
          <input
            className="cc-search-input"
            type="search"
            value={search}
            placeholder="Search name, number or message…"
            onChange={event => onSearchChange(event.target.value)}
            aria-label="Search conversations"
          />
          {search && (
            <button type="button" className="cc-search-clear" onClick={() => onSearchChange('')} aria-label="Clear search">
              <X size={13} />
            </button>
          )}
        </div>

        <div className="inbox-list-filters">
          <select
            className="cc-mini-select"
            value={status}
            onChange={event => onStatusChange(event.target.value as ConversationStatus | '')}
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            <option value="open">Open</option>
            <option value="waiting">Waiting</option>
            <option value="resolved">Resolved</option>
          </select>
          <select
            className="cc-mini-select"
            value={priority}
            onChange={event => onPriorityChange(event.target.value as ConversationPriority | '')}
            aria-label="Filter by priority"
          >
            <option value="">Any priority</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
          <select
            className="cc-mini-select"
            value={assignee}
            onChange={event => onAssigneeChange(event.target.value)}
            aria-label="Filter by assignee"
          >
            <option value="">Any assignee</option>
            <option value="unassigned">Unassigned</option>
            {agents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </div>

        <div className="inbox-list-meta">
          <span className="cc-num">
            {total} conversation{total === 1 ? '' : 's'}
          </span>
          {hasExtraFilters && (
            <span className="inbox-filter-hint">
              <Filter size={11} /> filtered
            </span>
          )}
          {/* A refetch of an already-populated list must not blank it — the spinner says work is
              happening while the rows stay put. */}
          {fetching && !loading && <Loader2 size={12} className="cc-spin" aria-label="Refreshing" />}
        </div>
      </div>

      <div className="inbox-list-scroll">
        {loading ? (
          <SkeletonList rows={8} height={64} />
        ) : error ? (
          <div style={{ padding: '1rem' }}>
            <ErrorState error={error} onRetry={onRetry} />
          </div>
        ) : conversations.length === 0 ? (
          <EmptyState
            icon={<Search size={20} />}
            title={search ? 'No matching conversations' : 'Nothing here yet'}
            description={
              search
                ? 'Try a different name, number or phrase. Search covers message content as well as contacts.'
                : 'Conversations appear as soon as messages arrive on a connected number. If you already have history, run the backfill from Overview.'
            }
          />
        ) : (
          <>
            <ul className="inbox-cards">
              {conversations.map(conversation => {
                const assigneeAgent = conversation.assigneeId ? agentsById.get(conversation.assigneeId) : undefined;
                const session = sessionsById.get(conversation.sessionId);
                const unread = conversation.unreadCount > 0 || conversation.manualUnread;
                const name = conversation.chatName || formatWaId(conversation.chatId);
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={`inbox-card is-${conversation.status} ${selectedId === conversation.id ? 'is-selected' : ''} ${unread ? 'is-unread' : ''}`}
                      onClick={() => onSelect(conversation)}
                      aria-current={selectedId === conversation.id ? 'true' : undefined}
                      title={session ? `${name} · ${session.name} · ${conversation.status}` : name}
                    >
                      <Avatar name={conversation.chatName} seed={conversation.chatId} />

                      <div className="inbox-card-body">
                        <div className="inbox-card-line">
                          <span className="inbox-card-name cc-truncate">{name}</span>
                          {conversation.priority === 'urgent' && (
                            <span className="inbox-card-flag is-urgent" title="Urgent">
                              !
                            </span>
                          )}
                          {conversation.priority === 'high' && (
                            <span className="inbox-card-flag is-high" title="High priority" />
                          )}
                          <span className="inbox-card-time cc-num">{relativeTime(conversation.lastMessageAt)}</span>
                        </div>

                        <div className="inbox-card-line">
                          <span className="inbox-card-preview cc-truncate">
                            {conversation.lastMessageDirection === 'outgoing' && (
                              <span className="inbox-card-you">You: </span>
                            )}
                            {conversation.lastMessagePreview ||
                              (conversation.lastMessageAt ? 'Message' : 'No messages yet')}
                          </span>
                          {conversation.unreadCount > 0 ? (
                            <span className="inbox-card-badge cc-num">
                              {conversation.unreadCount > 99 ? '99+' : conversation.unreadCount}
                            </span>
                          ) : conversation.manualUnread ? (
                            <span className="inbox-card-dot" aria-label="Marked unread" />
                          ) : null}
                        </div>

                        {/* A third line only when there is something worth saying. Status is NOT
                            shown per row: it is the thing you filter by, so repeating it on every
                            card was noise on the one line that has least room. */}
                        {((conversation.tags?.length ?? 0) > 0 || assigneeAgent || conversation.kind !== 'individual') && (
                          <div className="inbox-card-foot">
                            {(conversation.tags ?? []).slice(0, 2).map(tag => (
                              <span
                                key={tag.id}
                                className="inbox-card-tag"
                                style={{ '--tag': tag.color } as React.CSSProperties}
                              >
                                {tag.name}
                              </span>
                            ))}
                            {(conversation.tags?.length ?? 0) > 2 && (
                              <span className="inbox-card-kind">+{(conversation.tags?.length ?? 0) - 2}</span>
                            )}
                            {conversation.kind !== 'individual' && (
                              <span className="inbox-card-kind">{chatKindLabel(conversation.kind)}</span>
                            )}
                            <span className="inbox-card-spacer" />
                            {assigneeAgent && (
                              <span
                                className="inbox-card-assignee"
                                style={{ background: assigneeAgent.color }}
                                title={`Assigned to ${assigneeAgent.name}`}
                              >
                                {assigneeAgent.name.slice(0, 1).toUpperCase()}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>

            {canLoadMore && (
              <div className="inbox-list-more">
                <button type="button" className="cc-btn cc-btn-sm" onClick={onLoadMore} disabled={fetching}>
                  {fetching ? <Loader2 size={13} className="cc-spin" /> : null}
                  Load more
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

export default ConversationList;
