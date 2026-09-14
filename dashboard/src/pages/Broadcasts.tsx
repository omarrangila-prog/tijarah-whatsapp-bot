import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Megaphone,
  Pause,
  Play,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import {
  useBroadcastMutations,
  useBroadcastRecipientsQuery,
  useBroadcastsQuery,
  useTagsQuery,
} from '../hooks/commandCenter';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { EmptyState, ErrorState, Skeleton } from '../components/cc/Primitives';
import { absoluteTime, formatCount, formatWaId } from '../utils/ccFormat';
import type { AudiencePreview, Broadcast, BroadcastStatus } from '../services/commandCenter';
import './Broadcasts.css';

const STATUS_TONE: Record<BroadcastStatus, string> = {
  draft: 'neutral',
  pending_approval: 'high',
  scheduled: 'open',
  sending: 'open',
  paused: 'high',
  completed: 'resolved',
  cancelled: 'neutral',
};

/** The steps of the campaign workflow, shown as a progress spine on each campaign. */
const STEPS: Array<{ id: string; label: string; reached: (status: BroadcastStatus) => boolean }> = [
  { id: 'draft', label: 'Draft', reached: () => true },
  { id: 'approval', label: 'Approval', reached: status => status !== 'draft' },
  { id: 'sending', label: 'Sending', reached: status => ['sending', 'paused', 'completed'].includes(status) },
  { id: 'done', label: 'Done', reached: status => status === 'completed' },
];

interface DraftState {
  id: string | null;
  name: string;
  sessionId: string;
  body: string;
  tagIds: string[];
  customerType: string;
  city: string;
  throttleMs: string;
  scheduledAt: string;
}

const EMPTY: DraftState = {
  id: null,
  name: '',
  sessionId: '',
  body: '',
  tagIds: [],
  customerType: '',
  city: '',
  throttleMs: '3000',
  scheduledAt: '',
};

/**
 * Broadcast campaigns.
 *
 * The consent gate is stated on screen, not buried: the audience step always shows how many
 * contacts matched the filters and how many of those may actually be messaged, so an operator sees
 * the gap before they commit rather than wondering where their recipients went.
 */
export function Broadcasts() {
  useDocumentTitle('Broadcasts');
  const { success, error: showError } = useToast();
  const { canWrite, role } = useRole();

  const broadcastsQuery = useBroadcastsQuery();
  const sessionsQuery = useSessionsQuery();
  const tagsQuery = useTagsQuery();
  const mutations = useBroadcastMutations();

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const recipientsQuery = useBroadcastRecipientsQuery(expanded);
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const sessionsById = useMemo(() => new Map(sessions.map(session => [session.id, session])), [sessions]);
  const broadcasts = useMemo(() => broadcastsQuery.data ?? [], [broadcastsQuery.data]);

  const audienceOf = (state: DraftState) => ({
    ...(state.tagIds.length ? { tagIds: state.tagIds } : {}),
    ...(state.customerType.trim() ? { customerType: state.customerType.trim() } : {}),
    ...(state.city.trim() ? { city: state.city.trim() } : {}),
  });

  const runPreview = () => {
    if (!draft) return;
    mutations.previewAudience.mutate(audienceOf(draft), {
      onSuccess: setPreview,
      onError: error => showError(error instanceof Error ? error.message : 'Could not resolve the audience'),
    });
  };

  const save = () => {
    if (!draft) return;
    const payload: Partial<Broadcast> = {
      name: draft.name.trim(),
      sessionId: draft.sessionId,
      body: draft.body,
      audience: audienceOf(draft),
      throttleMs: Number(draft.throttleMs) || 3000,
      ...(draft.scheduledAt ? { scheduledAt: new Date(draft.scheduledAt).toISOString() as unknown as string } : {}),
    };
    const handlers = {
      onSuccess: () => {
        success(draft.id ? 'Campaign updated' : 'Campaign created');
        setDraft(null);
        setPreview(null);
      },
      onError: (error: unknown) => showError(error instanceof Error ? error.message : 'Could not save the campaign'),
    };
    if (draft.id) mutations.update.mutate({ id: draft.id, ...payload }, handlers);
    else mutations.create.mutate(payload, handlers);
  };

  const act = (action: 'submit' | 'approve' | 'pause' | 'resume' | 'cancel', id: string, label: string) => {
    mutations[action].mutate(id, {
      onSuccess: () => success(label),
      onError: error => showError(error instanceof Error ? error.message : `Could not ${action} the campaign`),
    });
  };

  return (
    <div className="cc-page bc">
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">Broadcasts</h1>
          <p className="cc-page-sub">
            Campaigns to contacts who have opted in. Consent is checked when the audience is built and again for every
            recipient at send time — there is no way to message someone who has not agreed to it.
          </p>
        </div>
        <button
          type="button"
          className="cc-btn cc-btn-primary"
          onClick={() => {
            setDraft({ ...EMPTY, sessionId: sessions[0]?.id ?? '' });
            setPreview(null);
          }}
          disabled={!canWrite || sessions.length === 0}
        >
          <Plus size={14} /> New campaign
        </button>
      </header>

      <div className="bc-layout">
        <div className="bc-list">
          {broadcastsQuery.isLoading ? (
            <Skeleton height={110} radius="var(--cc-radius-lg)" />
          ) : broadcastsQuery.error ? (
            <ErrorState error={broadcastsQuery.error} onRetry={() => void broadcastsQuery.refetch()} />
          ) : broadcasts.length === 0 ? (
            <div className="cc-card">
              <EmptyState
                icon={<Megaphone size={20} />}
                title="No campaigns yet"
                description="Build an audience from your opted-in contacts, write the message, preview it, and send it at a pace that keeps your number safe."
                action={
                  canWrite && sessions.length > 0 ? (
                    <button
                      type="button"
                      className="cc-btn cc-btn-primary cc-btn-sm"
                      onClick={() => setDraft({ ...EMPTY, sessionId: sessions[0].id })}
                    >
                      <Plus size={13} /> Create a campaign
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            broadcasts.map(broadcast => {
              const progress = broadcast.totalRecipients
                ? Math.round(((broadcast.sentCount + broadcast.failedCount) / broadcast.totalRecipients) * 100)
                : 0;
              return (
                <article key={broadcast.id} className="cc-card bc-card">
                  <div className="bc-card-head">
                    <h3 className="bc-card-name cc-truncate">{broadcast.name}</h3>
                    <span className={`cc-chip cc-chip-${STATUS_TONE[broadcast.status]}`}>
                      {broadcast.status.replace(/_/g, ' ')}
                    </span>
                    <span className="bc-card-session">{sessionsById.get(broadcast.sessionId)?.name ?? broadcast.sessionId}</span>
                  </div>

                  <ol className="bc-steps">
                    {STEPS.map(step => (
                      <li key={step.id} className={step.reached(broadcast.status) ? 'is-done' : ''}>
                        <span />
                        {step.label}
                      </li>
                    ))}
                  </ol>

                  <p className="bc-card-body">{broadcast.body}</p>

                  {broadcast.totalRecipients > 0 && (
                    <div className="bc-progress">
                      <div className="bc-progress-bar">
                        <span style={{ width: `${progress}%` }} />
                      </div>
                      <span className="cc-num">
                        {formatCount(broadcast.sentCount)} sent
                        {broadcast.failedCount > 0 && <span className="bc-failed"> · {broadcast.failedCount} failed</span>}
                        {' of '}
                        {formatCount(broadcast.totalRecipients)}
                      </span>
                    </div>
                  )}

                  <div className="bc-card-foot">
                    <span>{broadcast.throttleMs}ms between sends</span>
                    {broadcast.scheduledAt && <span>· scheduled {absoluteTime(broadcast.scheduledAt)}</span>}
                    {broadcast.approvedBy && <span>· approved by {broadcast.approvedBy}</span>}
                  </div>

                  <div className="bc-actions">
                    {broadcast.status === 'draft' && (
                      <>
                        <button
                          type="button"
                          className="cc-btn cc-btn-sm"
                          onClick={() =>
                            setDraft({
                              id: broadcast.id,
                              name: broadcast.name,
                              sessionId: broadcast.sessionId,
                              body: broadcast.body,
                              tagIds: broadcast.audience?.tagIds ?? [],
                              customerType: broadcast.audience?.customerType ?? '',
                              city: broadcast.audience?.city ?? '',
                              throttleMs: String(broadcast.throttleMs),
                              scheduledAt: '',
                            })
                          }
                          disabled={!canWrite}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="cc-btn cc-btn-primary cc-btn-sm"
                          onClick={() => act('submit', broadcast.id, 'Sent for approval')}
                          disabled={!canWrite}
                        >
                          Submit for approval
                        </button>
                      </>
                    )}
                    {broadcast.status === 'pending_approval' && (
                      <button
                        type="button"
                        className="cc-btn cc-btn-primary cc-btn-sm"
                        onClick={() => act('approve', broadcast.id, 'Campaign approved and started')}
                        disabled={role !== 'admin'}
                        title={role !== 'admin' ? 'Only an admin can approve a campaign' : undefined}
                      >
                        <ShieldCheck size={13} /> Approve &amp; send
                      </button>
                    )}
                    {(broadcast.status === 'sending' || broadcast.status === 'scheduled') && (
                      <button type="button" className="cc-btn cc-btn-sm" onClick={() => act('pause', broadcast.id, 'Campaign paused')} disabled={!canWrite}>
                        <Pause size={13} /> Pause
                      </button>
                    )}
                    {broadcast.status === 'paused' && (
                      <button type="button" className="cc-btn cc-btn-sm" onClick={() => act('resume', broadcast.id, 'Campaign resumed')} disabled={!canWrite}>
                        <Play size={13} /> Resume
                      </button>
                    )}
                    {!['completed', 'cancelled'].includes(broadcast.status) && (
                      <button type="button" className="cc-btn cc-btn-sm cc-btn-danger" onClick={() => act('cancel', broadcast.id, 'Campaign cancelled')} disabled={!canWrite}>
                        <X size={13} /> Cancel
                      </button>
                    )}
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() => setExpanded(expanded === broadcast.id ? null : broadcast.id)}
                    >
                      {expanded === broadcast.id ? 'Hide' : 'Recipients'}
                    </button>
                    {['draft', 'cancelled', 'completed'].includes(broadcast.status) && (
                      <button
                        type="button"
                        className="cc-btn cc-btn-ghost cc-btn-sm"
                        onClick={() => mutations.remove.mutate(broadcast.id, { onSuccess: () => success('Campaign deleted') })}
                        disabled={!canWrite}
                        aria-label="Delete campaign"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>

                  {expanded === broadcast.id && (
                    <div className="bc-recipients">
                      {recipientsQuery.isLoading ? (
                        <Skeleton height={60} />
                      ) : (recipientsQuery.data ?? []).length === 0 ? (
                        <p className="cc-hint">
                          Recipients are built when the campaign is approved — nothing is materialised before that.
                        </p>
                      ) : (
                        <div className="cc-table-scroll">
                          <table className="cc-table">
                            <thead>
                              <tr>
                                <th>Contact</th>
                                <th>Status</th>
                                <th>Sent</th>
                                <th>Note</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(recipientsQuery.data ?? []).slice(0, 50).map(recipient => (
                                <tr key={recipient.id}>
                                  <td>{recipient.name || formatWaId(recipient.waId)}</td>
                                  <td>
                                    <span
                                      className={`cc-chip cc-chip-${
                                        recipient.status === 'failed' ? 'urgent' : recipient.status === 'sent' ? 'resolved' : 'neutral'
                                      }`}
                                    >
                                      {recipient.status}
                                    </span>
                                  </td>
                                  <td className="cc-num">{recipient.sentAt ? absoluteTime(recipient.sentAt) : '—'}</td>
                                  <td className="cc-truncate" style={{ maxWidth: 240 }}>
                                    {recipient.error ?? '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })
          )}
        </div>

        {draft && (
          <aside className="cc-card bc-editor">
            <div className="cc-card-head">
              <h2 className="cc-card-title">{draft.id ? 'Edit campaign' : 'New campaign'}</h2>
            </div>
            <div className="cc-card-body">
              <label className="cc-field">
                <span>Campaign name</span>
                <input className="cc-input" value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} />
              </label>

              <label className="cc-field">
                <span>Send from</span>
                <select className="cc-select" value={draft.sessionId} onChange={event => setDraft({ ...draft, sessionId: event.target.value })}>
                  {sessions.map(session => (
                    <option key={session.id} value={session.id}>
                      {session.name}
                    </option>
                  ))}
                </select>
              </label>

              <p className="cc-label">Audience</p>
              <div className="bc-audience">
                <div className="bc-tag-picker">
                  {(tagsQuery.data ?? []).map(tag => (
                    <button
                      key={tag.id}
                      type="button"
                      className={`cc-tag-toggle ${draft.tagIds.includes(tag.id) ? 'is-active' : ''}`}
                      style={{ '--tag': tag.color } as React.CSSProperties}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          tagIds: draft.tagIds.includes(tag.id)
                            ? draft.tagIds.filter(id => id !== tag.id)
                            : [...draft.tagIds, tag.id],
                        })
                      }
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
                <div className="cc-row" style={{ gap: '0.35rem', marginTop: '0.4rem' }}>
                  <input
                    className="cc-input"
                    placeholder="Customer type"
                    value={draft.customerType}
                    onChange={event => setDraft({ ...draft, customerType: event.target.value })}
                  />
                  <input className="cc-input" placeholder="City" value={draft.city} onChange={event => setDraft({ ...draft, city: event.target.value })} />
                </div>
                <button type="button" className="cc-btn cc-btn-sm" style={{ marginTop: '0.45rem' }} onClick={runPreview} disabled={mutations.previewAudience.isPending}>
                  {mutations.previewAudience.isPending ? <Loader2 size={12} className="cc-spin" /> : <Users size={12} />} Preview audience
                </button>

                {preview && (
                  <div className={`bc-preview ${preview.optedIn === 0 ? 'is-empty' : ''}`}>
                    <div className="bc-preview-nums">
                      <span>
                        <b className="cc-num">{formatCount(preview.optedIn)}</b> will be messaged
                      </span>
                      <span className="cc-num">{formatCount(preview.matched)} matched the filters</span>
                    </div>
                    {preview.excludedNoConsent > 0 && (
                      <p className="bc-preview-warn">
                        <AlertTriangle size={12} />
                        {formatCount(preview.excludedNoConsent)} excluded — no recorded opt-in. Record consent on the
                        Contacts page to include them.
                      </p>
                    )}
                    {preview.optedIn === 0 && (
                      <p className="bc-preview-warn">
                        <AlertTriangle size={12} /> Nobody can be messaged with this audience. Approval will be refused.
                      </p>
                    )}
                    {preview.sample.length > 0 && (
                      <p className="cc-hint">
                        e.g. {preview.sample.slice(0, 3).map(person => person.name || formatWaId(person.waId)).join(', ')}
                      </p>
                    )}
                  </div>
                )}
              </div>

              <label className="cc-field" style={{ marginTop: '1rem' }}>
                <span>Message</span>
                <textarea
                  className="cc-textarea"
                  rows={6}
                  value={draft.body}
                  placeholder="Hi {{name}}, our new collection is live…"
                  onChange={event => setDraft({ ...draft, body: event.target.value })}
                />
                <p className="cc-hint">Supports {'{{name}}'} and {'{{phone}}'}.</p>
              </label>

              {draft.body.trim() && (
                <div className="bc-message-preview">
                  <p className="cc-label" style={{ marginBottom: '0.35rem' }}>
                    Preview
                  </p>
                  <div className="bc-bubble">{draft.body.replace(/\{\{name\}\}/g, 'Sana').replace(/\{\{phone\}\}/g, '923001234567')}</div>
                </div>
              )}

              <label className="cc-field" style={{ marginTop: '1rem' }}>
                <span>Gap between sends (ms)</span>
                <input
                  className="cc-input"
                  type="number"
                  min={1500}
                  step={500}
                  value={draft.throttleMs}
                  onChange={event => setDraft({ ...draft, throttleMs: event.target.value })}
                />
                <p className="cc-hint">
                  Minimum 1500ms. Sending faster than this is how numbers get blocked, so the server raises anything
                  lower.
                </p>
              </label>

              <label className="cc-field">
                <span>Start at (optional)</span>
                <input className="cc-input" type="datetime-local" value={draft.scheduledAt} onChange={event => setDraft({ ...draft, scheduledAt: event.target.value })} />
                <p className="cc-hint">Leave empty to start as soon as the campaign is approved.</p>
              </label>

              <div className="cc-row" style={{ gap: '0.4rem' }}>
                <button
                  type="button"
                  className="cc-btn cc-btn-primary"
                  onClick={save}
                  disabled={!draft.name.trim() || !draft.body.trim() || !draft.sessionId || mutations.create.isPending || mutations.update.isPending}
                >
                  {mutations.create.isPending || mutations.update.isPending ? <Loader2 size={13} className="cc-spin" /> : <Send size={13} />}
                  {draft.id ? 'Save draft' : 'Create draft'}
                </button>
                <button
                  type="button"
                  className="cc-btn"
                  onClick={() => {
                    setDraft(null);
                    setPreview(null);
                  }}
                >
                  Cancel
                </button>
              </div>
              <p className="cc-hint">
                <CheckCircle2 size={11} style={{ verticalAlign: '-1px' }} /> Creating a draft sends nothing. A campaign
                only goes out after an admin approves it.
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export default Broadcasts;
