import { Archive, CheckCircle2, Clock, Inbox as InboxIcon, Mail, Star, User, UserX } from 'lucide-react';
import type { Session } from '../../services/api';
import type { Tag } from '../../services/commandCenter';
import { HealthDot } from '../cc/Primitives';

import type { InboxView } from '../../utils/inboxFilters';

/**
 * The saved views, in the order they appear. Local to this file (not exported) so the module stays
 * a component-only export, which is what keeps fast refresh working during development.
 */
const INBOX_VIEWS: Array<{ id: InboxView; label: string; icon: typeof InboxIcon }> = [
  { id: 'all', label: 'All conversations', icon: InboxIcon },
  { id: 'mine', label: 'Mine', icon: User },
  { id: 'unassigned', label: 'Unassigned', icon: UserX },
  { id: 'unread', label: 'Unread', icon: Mail },
  { id: 'waiting', label: 'Waiting', icon: Clock },
  { id: 'resolved', label: 'Resolved', icon: CheckCircle2 },
  { id: 'starred', label: 'Starred', icon: Star },
];

interface InboxRailProps {
  view: InboxView;
  onViewChange: (view: InboxView) => void;
  /** Row counts per view, when known. Undefined renders no badge rather than a misleading zero. */
  counts?: Partial<Record<InboxView, number>>;
  sessions: Session[];
  selectedSessionIds: string[];
  onToggleSession: (sessionId: string) => void;
  tags: Tag[];
  selectedTagIds: string[];
  onToggleTag: (tagId: string) => void;
}

/**
 * The inbox's left rail: saved views, the connected numbers with their health, and the tag filter.
 *
 * Numbers are toggles, not a single selection, because the whole point of the product is working
 * several WhatsApp numbers in one place — an operator needs to see two lines at once as easily as
 * one, and "all numbers" is simply none of them selected.
 */
export function InboxRail({
  view,
  onViewChange,
  counts,
  sessions,
  selectedSessionIds,
  onToggleSession,
  tags,
  selectedTagIds,
  onToggleTag,
}: InboxRailProps) {
  return (
    <nav className="inbox-rail" aria-label="Inbox filters">
      <div className="inbox-rail-section">
        <p className="cc-label">Views</p>
        <ul className="inbox-rail-list">
          {INBOX_VIEWS.map(item => {
            const Icon = item.icon;
            const count = counts?.[item.id];
            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={`inbox-rail-item ${view === item.id ? 'is-active' : ''}`}
                  onClick={() => onViewChange(item.id)}
                  aria-current={view === item.id ? 'true' : undefined}
                >
                  <Icon size={15} />
                  <span className="cc-truncate">{item.label}</span>
                  {count !== undefined && count > 0 && <span className="inbox-rail-count cc-num">{count}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="inbox-rail-section">
        <p className="cc-label">WhatsApp numbers</p>
        {sessions.length === 0 ? (
          <p className="inbox-rail-empty">No numbers connected yet.</p>
        ) : (
          <ul className="inbox-rail-list">
            {sessions.map(session => {
              const active = selectedSessionIds.includes(session.id);
              return (
                <li key={session.id}>
                  <button
                    type="button"
                    className={`inbox-rail-item ${active ? 'is-active' : ''}`}
                    onClick={() => onToggleSession(session.id)}
                    aria-pressed={active}
                    title={`${session.name} — ${session.status}${session.phone ? ` — ${session.phone}` : ''}`}
                  >
                    <HealthDot status={session.status} />
                    <span className="cc-truncate">{session.name}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {selectedSessionIds.length > 0 && (
          <p className="inbox-rail-note">
            Filtering {selectedSessionIds.length} of {sessions.length} numbers
          </p>
        )}
      </div>

      {tags.length > 0 && (
        <div className="inbox-rail-section">
          <p className="cc-label">Tags</p>
          <div className="inbox-rail-tags">
            {tags.map(tag => {
              const active = selectedTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  className={`cc-tag-toggle ${active ? 'is-active' : ''}`}
                  style={{ '--tag': tag.color } as React.CSSProperties}
                  onClick={() => onToggleTag(tag.id)}
                  aria-pressed={active}
                >
                  {tag.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="inbox-rail-footer">
        <Archive size={13} />
        <span>Conversations are indexed from your message history.</span>
      </div>
    </nav>
  );
}

export default InboxRail;
