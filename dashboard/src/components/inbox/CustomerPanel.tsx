import { useEffect, useState } from 'react';
import { Check, Loader2, Pencil, Plus, ShieldCheck, ShieldOff, ShieldQuestion, Trash2, X } from 'lucide-react';
import type {
  Agent,
  ConsentStatus,
  Conversation,
  ConversationNote,
  Customer,
  Tag,
  Team,
} from '../../services/commandCenter';
import type { Session } from '../../services/api';
import { Avatar, ErrorState, Skeleton, TagChip } from '../cc/Primitives';
import { TijarahClientSection } from './TijarahClientSection';
import { absoluteTime, chatKindLabel, dateOnly, formatCount, formatWaId } from '../../utils/ccFormat';

interface CustomerPanelProps {
  conversation: Conversation;
  customer: Customer | undefined;
  customerLoading: boolean;
  customerError: unknown;
  session: Session | undefined;
  agents: Agent[];
  teams: Team[];
  tags: Tag[];
  notes: ConversationNote[];
  notesLoading: boolean;
  profilePictureUrl: string | null;
  onSaveProfile: (patch: Partial<Customer>) => void;
  savingProfile: boolean;
  onSetConsent: (status: ConsentStatus, source?: string) => void;
  onAddTag: (tagId: string) => void;
  onRemoveTag: (tagId: string) => void;
  onAddNote: (body: string) => void;
  onDeleteNote: (noteId: string) => void;
  addingNote: boolean;
  onCreateFollowUp: (title: string, dueAt: string) => void;
}

const CONSENT_META: Record<ConsentStatus, { label: string; icon: typeof ShieldCheck; tone: string }> = {
  opted_in: { label: 'Opted in', icon: ShieldCheck, tone: 'resolved' },
  opted_out: { label: 'Opted out', icon: ShieldOff, tone: 'urgent' },
  unknown: { label: 'No consent recorded', icon: ShieldQuestion, tone: 'neutral' },
};

/**
 * The right-hand customer panel: identity, business fields, consent, tags, notes and follow-ups.
 *
 * Profile edits are staged locally and saved explicitly rather than on every keystroke — an
 * operator typing a company name should not generate a request per character, and an accidental
 * keypress should not be persisted before they have finished the thought.
 */
export function CustomerPanel({
  conversation,
  customer,
  customerLoading,
  customerError,
  session,
  agents,
  teams,
  tags,
  notes,
  notesLoading,
  profilePictureUrl,
  onSaveProfile,
  savingProfile,
  onSetConsent,
  onAddTag,
  onRemoveTag,
  onAddNote,
  onDeleteNote,
  addingNote,
  onCreateFollowUp,
}: CustomerPanelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<Customer>>({});
  const [noteDraft, setNoteDraft] = useState('');
  const [newField, setNewField] = useState({ key: '', value: '' });
  const [followUp, setFollowUp] = useState({ title: '', days: '1' });
  const [consentSource, setConsentSource] = useState('');
  const [showConsentForm, setShowConsentForm] = useState(false);

  // Reset the edit form whenever the panel switches to a different person, so a half-typed edit
  // never leaks onto the next customer's record.
  useEffect(() => {
    setEditing(false);
    setDraft({});
    setNewField({ key: '', value: '' });
    setShowConsentForm(false);
    setConsentSource('');
  }, [conversation.id]);

  const assignee = agents.find(agent => agent.id === conversation.assigneeId);
  const team = teams.find(item => item.id === conversation.teamId);
  const consent = customer?.consent?.status ?? 'unknown';
  const ConsentIcon = CONSENT_META[consent].icon;
  const availableTags = tags.filter(tag => !(conversation.tags ?? []).some(existing => existing.id === tag.id));
  const displayName = customer?.displayName || conversation.chatName || formatWaId(conversation.chatId);

  const startEdit = () => {
    setDraft({
      displayName: customer?.displayName ?? '',
      company: customer?.company ?? '',
      email: customer?.email ?? '',
      source: customer?.source ?? '',
      customerType: customer?.customerType ?? '',
      city: customer?.city ?? '',
      customFields: { ...(customer?.customFields ?? {}) },
    });
    setEditing(true);
  };

  const commit = () => {
    onSaveProfile(draft);
    setEditing(false);
  };

  return (
    <div className="inbox-cust-panel">
      <header className="inbox-cust-head">
        <Avatar name={displayName} seed={conversation.chatId} src={profilePictureUrl} size="lg" />
        <h3 className="inbox-cust-name">{displayName}</h3>
        <p className="inbox-cust-number">{formatWaId(conversation.chatId)}</p>
        <div className="inbox-cust-head-meta">
          {session && <span className="cc-chip cc-chip-neutral">{session.name}</span>}
          <span className="cc-chip cc-chip-neutral">{chatKindLabel(conversation.kind)}</span>
        </div>
      </header>

      {customerError ? (
        <div style={{ padding: '0 1rem' }}>
          <ErrorState error={customerError} />
        </div>
      ) : null}

      {/* ── Tijarah client: whether the bot serves this number ──────── */}
      <TijarahClientSection chatId={conversation.chatId} />

      {/* ── Assignment ─────────────────────────────────────────────── */}
      <section className="inbox-cust-section">
        <p className="cc-label">Ownership</p>
        <dl className="inbox-cust-facts">
          <div>
            <dt>Assigned to</dt>
            <dd>
              {assignee ? (
                <span className="cc-row" style={{ gap: '0.35rem' }}>
                  <span className="inbox-card-assignee" style={{ background: assignee.color }}>
                    {assignee.name.slice(0, 1).toUpperCase()}
                  </span>
                  {assignee.name}
                </span>
              ) : (
                <span className="cc-muted">Unassigned</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Team</dt>
            <dd>{team ? team.name : <span className="cc-muted">None</span>}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{dateOnly(conversation.createdAt)}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{absoluteTime(conversation.lastMessageAt)}</dd>
          </div>
        </dl>
      </section>

      {/* ── Tags ───────────────────────────────────────────────────── */}
      <section className="inbox-cust-section">
        <p className="cc-label">Tags</p>
        <div className="inbox-cust-tags">
          {(conversation.tags ?? []).map(tag => (
            <TagChip key={tag.id} tag={tag} onRemove={() => onRemoveTag(tag.id)} />
          ))}
          {(conversation.tags?.length ?? 0) === 0 && <span className="cc-muted">No tags yet</span>}
        </div>
        {availableTags.length > 0 && (
          <select
            className="cc-select"
            style={{ marginTop: '0.5rem' }}
            value=""
            onChange={event => {
              if (event.target.value) onAddTag(event.target.value);
            }}
            aria-label="Add a tag"
          >
            <option value="">Add a tag…</option>
            {availableTags.map(tag => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
        )}
      </section>

      {/* ── Customer profile ───────────────────────────────────────── */}
      <section className="inbox-cust-section">
        <div className="cc-row-between" style={{ marginBottom: '0.5rem' }}>
          <p className="cc-label" style={{ margin: 0 }}>
            Customer details
          </p>
          {!editing ? (
            <button type="button" className="cc-btn cc-btn-ghost cc-btn-sm" onClick={startEdit}>
              <Pencil size={12} /> Edit
            </button>
          ) : (
            <span className="cc-row" style={{ gap: '0.3rem' }}>
              <button type="button" className="cc-btn cc-btn-ghost cc-btn-sm" onClick={() => setEditing(false)}>
                <X size={12} />
              </button>
              <button type="button" className="cc-btn cc-btn-primary cc-btn-sm" onClick={commit} disabled={savingProfile}>
                {savingProfile ? <Loader2 size={12} className="cc-spin" /> : <Check size={12} />} Save
              </button>
            </span>
          )}
        </div>

        {customerLoading ? (
          <div className="cc-stack" style={{ gap: '0.5rem' }}>
            <Skeleton height={30} />
            <Skeleton height={30} />
            <Skeleton height={30} />
          </div>
        ) : editing ? (
          <div className="inbox-cust-form">
            {(
              [
                ['displayName', 'Name'],
                ['company', 'Company'],
                ['email', 'Email'],
                ['customerType', 'Customer type'],
                ['city', 'City'],
                ['source', 'Source'],
              ] as const
            ).map(([field, label]) => (
              <label key={field} className="cc-field">
                <span>{label}</span>
                <input
                  className="cc-input"
                  type={field === 'email' ? 'email' : 'text'}
                  value={(draft[field] as string) ?? ''}
                  onChange={event => setDraft(current => ({ ...current, [field]: event.target.value }))}
                />
              </label>
            ))}

            <p className="cc-label">Custom fields</p>
            {Object.entries(draft.customFields ?? {}).map(([key, value]) => (
              <div key={key} className="inbox-cust-custom-row">
                <span className="inbox-cust-custom-key cc-truncate">{key}</span>
                <input
                  className="cc-input"
                  value={value}
                  aria-label={`${key} value`}
                  onChange={event =>
                    setDraft(current => ({
                      ...current,
                      customFields: { ...(current.customFields ?? {}), [key]: event.target.value },
                    }))
                  }
                />
                <button
                  type="button"
                  className="cc-btn cc-btn-ghost cc-btn-sm"
                  onClick={() =>
                    setDraft(current => {
                      const next = { ...(current.customFields ?? {}) };
                      delete next[key];
                      return { ...current, customFields: next };
                    })
                  }
                  aria-label={`Remove ${key}`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
            <div className="inbox-cust-custom-row">
              <input
                className="cc-input"
                placeholder="Field name"
                value={newField.key}
                onChange={event => setNewField(current => ({ ...current, key: event.target.value }))}
              />
              <input
                className="cc-input"
                placeholder="Value"
                value={newField.value}
                onChange={event => setNewField(current => ({ ...current, value: event.target.value }))}
              />
              <button
                type="button"
                className="cc-btn cc-btn-sm"
                disabled={!newField.key.trim()}
                onClick={() => {
                  setDraft(current => ({
                    ...current,
                    customFields: { ...(current.customFields ?? {}), [newField.key.trim()]: newField.value },
                  }));
                  setNewField({ key: '', value: '' });
                }}
              >
                <Plus size={12} />
              </button>
            </div>
          </div>
        ) : (
          <dl className="inbox-cust-facts">
            <div>
              <dt>Company</dt>
              <dd>{customer?.company || <span className="cc-muted">—</span>}</dd>
            </div>
            <div>
              <dt>Email</dt>
              <dd className="cc-truncate">{customer?.email || <span className="cc-muted">—</span>}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{customer?.customerType || <span className="cc-muted">—</span>}</dd>
            </div>
            <div>
              <dt>City</dt>
              <dd>{customer?.city || <span className="cc-muted">—</span>}</dd>
            </div>
            <div>
              <dt>Source</dt>
              <dd>{customer?.source || <span className="cc-muted">—</span>}</dd>
            </div>
            <div>
              <dt>Messages</dt>
              <dd className="cc-num">{formatCount(customer?.messageCount)}</dd>
            </div>
            <div>
              <dt>First seen</dt>
              <dd>{dateOnly(customer?.firstInteractionAt)}</dd>
            </div>
            <div>
              <dt>Numbers used</dt>
              <dd className="cc-num">{customer?.sessionIds.length ?? 0}</dd>
            </div>
            {Object.entries(customer?.customFields ?? {}).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd className="cc-truncate" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* ── Consent ────────────────────────────────────────────────── */}
      <section className="inbox-cust-section">
        <p className="cc-label">Marketing consent</p>
        <div className={`cc-consent is-${CONSENT_META[consent].tone}`}>
          <ConsentIcon size={14} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <strong>{CONSENT_META[consent].label}</strong>
            {customer?.consent?.source && <span className="cc-consent-source">{customer.consent.source}</span>}
          </div>
        </div>
        {consent !== 'opted_in' ? (
          showConsentForm ? (
            <div className="cc-stack" style={{ gap: '0.4rem', marginTop: '0.5rem' }}>
              <input
                className="cc-input"
                placeholder="How was consent obtained?"
                value={consentSource}
                onChange={event => setConsentSource(event.target.value)}
              />
              <p className="cc-hint">Required — a broadcast can only reach contacts with a recorded opt-in.</p>
              <div className="cc-row" style={{ gap: '0.4rem' }}>
                <button
                  type="button"
                  className="cc-btn cc-btn-primary cc-btn-sm"
                  disabled={!consentSource.trim()}
                  onClick={() => {
                    onSetConsent('opted_in', consentSource.trim());
                    setShowConsentForm(false);
                    setConsentSource('');
                  }}
                >
                  Record opt-in
                </button>
                <button type="button" className="cc-btn cc-btn-sm" onClick={() => setShowConsentForm(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="cc-btn cc-btn-sm"
              style={{ marginTop: '0.5rem' }}
              onClick={() => setShowConsentForm(true)}
            >
              Record opt-in
            </button>
          )
        ) : (
          <button
            type="button"
            className="cc-btn cc-btn-sm cc-btn-danger"
            style={{ marginTop: '0.5rem' }}
            onClick={() => onSetConsent('opted_out')}
          >
            Record opt-out
          </button>
        )}
      </section>

      {/* ── Notes ──────────────────────────────────────────────────── */}
      <section className="inbox-cust-section">
        <p className="cc-label">Internal notes</p>
        <p className="cc-hint" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
          Visible to your team only. Notes are never sent to WhatsApp.
        </p>
        <textarea
          className="cc-textarea"
          rows={3}
          placeholder="Add a note…"
          value={noteDraft}
          onChange={event => setNoteDraft(event.target.value)}
        />
        <button
          type="button"
          className="cc-btn cc-btn-sm"
          style={{ marginTop: '0.4rem' }}
          disabled={!noteDraft.trim() || addingNote}
          onClick={() => {
            onAddNote(noteDraft.trim());
            setNoteDraft('');
          }}
        >
          {addingNote ? <Loader2 size={12} className="cc-spin" /> : <Plus size={12} />} Add note
        </button>

        <div className="inbox-cust-notes">
          {notesLoading ? (
            <Skeleton height={48} />
          ) : notes.length === 0 ? (
            <p className="cc-muted" style={{ fontSize: '0.75rem' }}>
              No notes yet.
            </p>
          ) : (
            notes.map(note => (
              <article key={note.id} className="inbox-cust-note">
                <div className="inbox-cust-note-head">
                  <span>{note.authorName ?? 'Unknown'}</span>
                  <time dateTime={note.createdAt}>{absoluteTime(note.createdAt)}</time>
                  <button
                    type="button"
                    className="cc-btn cc-btn-ghost cc-btn-sm"
                    onClick={() => onDeleteNote(note.id)}
                    aria-label="Delete note"
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
                <p>{note.body}</p>
              </article>
            ))
          )}
        </div>
      </section>

      {/* ── Follow-up ──────────────────────────────────────────────── */}
      <section className="inbox-cust-section">
        <p className="cc-label">Create follow-up</p>
        <input
          className="cc-input"
          placeholder="What needs doing?"
          value={followUp.title}
          onChange={event => setFollowUp(current => ({ ...current, title: event.target.value }))}
        />
        <div className="cc-row" style={{ gap: '0.4rem', marginTop: '0.4rem' }}>
          <select
            className="cc-select"
            value={followUp.days}
            onChange={event => setFollowUp(current => ({ ...current, days: event.target.value }))}
            aria-label="Due in"
          >
            <option value="0.04">In an hour</option>
            <option value="1">Tomorrow</option>
            <option value="3">In 3 days</option>
            <option value="7">Next week</option>
          </select>
          <button
            type="button"
            className="cc-btn cc-btn-sm"
            disabled={!followUp.title.trim()}
            onClick={() => {
              const dueAt = new Date(Date.now() + Number(followUp.days) * 86_400_000).toISOString();
              onCreateFollowUp(followUp.title.trim(), dueAt);
              setFollowUp({ title: '', days: '1' });
            }}
          >
            Add
          </button>
        </div>
      </section>
    </div>
  );
}

export default CustomerPanel;
