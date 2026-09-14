import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Bell,
  Brain,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock,
  Database,
  FileText,
  Info,
  Key,
  Loader2,
  MessageSquare,
  Puzzle,
  Send,
  Server,
  ShieldCheck,
  Tag as TagIcon,
  Trash2,
  Webhook,
  Wrench,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { aiApi } from '../services/commandCenter';
import {
  useBackfillMutation,
  useFollowUpMutations,
  useFollowUpsQuery,
  useScheduledMessageMutations,
  useScheduledMessagesQuery,
  useTagMutations,
  useTagsQuery,
} from '../hooks/commandCenter';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { EmptyState, ErrorState, Skeleton, TagChip } from '../components/cc/Primitives';
import { absoluteTime, formatWaId } from '../utils/ccFormat';
import './CommandSettings.css';

const TAG_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#8b5cf6'];

/**
 * Workspace settings: tags, follow-ups, the scheduled-send queue, the AI provider's state, and the
 * one-off conversation backfill. Deliberately a single page — each of these is a handful of
 * controls, and five near-empty pages would be worse than one honest one.
 */
export function CommandSettings() {
  useDocumentTitle('Settings');
  const { success, error: showError } = useToast();
  const { canWrite, role } = useRole();

  const tagsQuery = useTagsQuery();
  const tagMutations = useTagMutations();
  const followUpsQuery = useFollowUpsQuery({ status: 'pending' });
  const followUpMutations = useFollowUpMutations();
  const scheduledQuery = useScheduledMessagesQuery({ status: 'pending' });
  const scheduledMutations = useScheduledMessageMutations();
  const sessionsQuery = useSessionsQuery();
  const backfill = useBackfillMutation();
  const aiStatusQuery = useQuery({ queryKey: ['cc', 'ai', 'status'], queryFn: aiApi.status, staleTime: 60_000 });

  const [newTag, setNewTag] = useState({ name: '', color: TAG_COLORS[0] });

  const sessionsById = useMemo(
    () => new Map((sessionsQuery.data ?? []).map(session => [session.id, session])),
    [sessionsQuery.data],
  );

  return (
    <div className="cc-page set">
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">Settings</h1>
          <p className="cc-page-sub">Workspace configuration for the command center. Gateway settings live under Admin.</p>
        </div>
      </header>

      <div className="set-grid">
        {/* ── Tags ───────────────────────────────────────────────── */}
        <section className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">
              <TagIcon size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
              Tags
            </h2>
          </div>
          <div className="cc-card-body">
            <p className="cc-hint" style={{ marginTop: 0 }}>
              Workspace tags, usable on any number and by automations. Separate from WhatsApp Business labels, which
              live on the account itself and only exist on Business numbers.
            </p>

            <div className="set-tags">
              {tagsQuery.isLoading ? (
                <Skeleton height={26} width={200} />
              ) : (tagsQuery.data ?? []).length === 0 ? (
                <span className="cc-hint">No tags yet.</span>
              ) : (
                (tagsQuery.data ?? []).map(tag => (
                  <TagChip
                    key={tag.id}
                    tag={tag}
                    onRemove={
                      canWrite
                        ? () => tagMutations.remove.mutate(tag.id, { onSuccess: () => success('Tag deleted') })
                        : undefined
                    }
                  />
                ))
              )}
            </div>

            {canWrite && (
              <div className="set-tag-form">
                <input
                  className="cc-input"
                  placeholder="New tag name"
                  value={newTag.name}
                  onChange={event => setNewTag({ ...newTag, name: event.target.value })}
                  onKeyDown={event => {
                    if (event.key === 'Enter' && newTag.name.trim()) {
                      tagMutations.create.mutate(newTag, {
                        onSuccess: () => {
                          success('Tag created');
                          setNewTag({ name: '', color: newTag.color });
                        },
                        onError: error => showError(error instanceof Error ? error.message : 'Could not create the tag'),
                      });
                    }
                  }}
                />
                <div className="cc-swatch-row">
                  {TAG_COLORS.map(color => (
                    <button
                      key={color}
                      type="button"
                      className={`cc-swatch-btn ${newTag.color === color ? 'is-active' : ''}`}
                      style={{ background: color }}
                      onClick={() => setNewTag({ ...newTag, color })}
                      aria-label={`Use colour ${color}`}
                    />
                  ))}
                </div>
                <button
                  type="button"
                  className="cc-btn cc-btn-sm"
                  disabled={!newTag.name.trim() || tagMutations.create.isPending}
                  onClick={() =>
                    tagMutations.create.mutate(newTag, {
                      onSuccess: () => {
                        success('Tag created');
                        setNewTag({ name: '', color: newTag.color });
                      },
                      onError: error => showError(error instanceof Error ? error.message : 'Could not create the tag'),
                    })
                  }
                >
                  Add
                </button>
              </div>
            )}
          </div>
        </section>

        {/* ── AI provider ────────────────────────────────────────── */}
        <section className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">
              <Brain size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
              AI copilot
            </h2>
          </div>
          <div className="cc-card-body">
            {aiStatusQuery.isLoading ? (
              <Skeleton height={54} />
            ) : aiStatusQuery.error ? (
              <ErrorState error={aiStatusQuery.error} onRetry={() => void aiStatusQuery.refetch()} />
            ) : (
              <>
                <div className={`set-ai ${aiStatusQuery.data?.degraded ? 'is-degraded' : 'is-ok'}`}>
                  {aiStatusQuery.data?.degraded ? <Info size={15} /> : <CheckCircle2 size={15} />}
                  <div>
                    <strong>
                      {aiStatusQuery.data?.degraded
                        ? 'Running on the built-in offline analyser'
                        : `Connected to ${aiStatusQuery.data?.provider}`}
                    </strong>
                    <p>
                      {aiStatusQuery.data?.degraded
                        ? 'Summaries, intent, sentiment and reply drafts still work — they are rule-based rather than model-generated, and the copilot labels them as such. Translation needs a model.'
                        : `Model: ${aiStatusQuery.data?.model ?? 'default'}`}
                    </p>
                  </div>
                </div>
                <p className="cc-hint">
                  Set <code>AI_API_KEY</code> (and optionally <code>AI_MODEL</code>) in the gateway environment to enable
                  a language model. The copilot never sends a WhatsApp message on its own — every draft is reviewed in
                  the composer first.
                </p>
              </>
            )}
          </div>
        </section>

        {/* ── Follow-ups ─────────────────────────────────────────── */}
        <section className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">
              <Bell size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
              Open follow-ups
            </h2>
          </div>
          <div className="cc-card-body" style={{ padding: 0 }}>
            {followUpsQuery.isLoading ? (
              <div style={{ padding: '1rem' }}>
                <Skeleton height={40} />
              </div>
            ) : (followUpsQuery.data ?? []).length === 0 ? (
              <EmptyState icon={<Bell size={18} />} title="Nothing due" description="Follow-ups you create from a conversation appear here." />
            ) : (
              <ul className="set-rows">
                {(followUpsQuery.data ?? []).map(item => (
                  <li key={item.id}>
                    <Clock size={13} />
                    <span className="set-row-main cc-truncate">{item.title}</span>
                    <time className="set-row-time">{absoluteTime(item.dueAt)}</time>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() => followUpMutations.setStatus.mutate({ id: item.id, status: 'done' }, { onSuccess: () => success('Follow-up completed') })}
                      disabled={!canWrite}
                    >
                      <CheckCircle2 size={12} /> Done
                    </button>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() => followUpMutations.remove.mutate(item.id)}
                      disabled={!canWrite}
                      aria-label="Delete follow-up"
                    >
                      <Trash2 size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ── Scheduled messages ─────────────────────────────────── */}
        <section className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">
              <CalendarClock size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
              Scheduled messages
            </h2>
          </div>
          <div className="cc-card-body" style={{ padding: 0 }}>
            {scheduledQuery.isLoading ? (
              <div style={{ padding: '1rem' }}>
                <Skeleton height={40} />
              </div>
            ) : (scheduledQuery.data ?? []).length === 0 ? (
              <EmptyState
                icon={<CalendarClock size={18} />}
                title="Nothing queued"
                description="Use Schedule in the inbox composer to send a message at a specific time."
              />
            ) : (
              <ul className="set-rows">
                {(scheduledQuery.data ?? []).map(item => (
                  <li key={item.id}>
                    <CalendarClock size={13} />
                    <span className="set-row-main cc-truncate" title={item.body}>
                      {formatWaId(item.chatId)} · {item.body}
                    </span>
                    <span className="cc-chip cc-chip-neutral">{sessionsById.get(item.sessionId)?.name ?? 'number'}</span>
                    <time className="set-row-time">{absoluteTime(item.runAt)}</time>
                    <button
                      type="button"
                      className="cc-btn cc-btn-ghost cc-btn-sm"
                      onClick={() => scheduledMutations.cancel.mutate(item.id, { onSuccess: () => success('Scheduled message cancelled') })}
                      disabled={!canWrite}
                    >
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* ── Maintenance ────────────────────────────────────────── */}
        <section className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">
              <Database size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
              Conversation index
            </h2>
          </div>
          <div className="cc-card-body">
            <p className="cc-hint" style={{ marginTop: 0 }}>
              Conversations are built automatically from incoming and outgoing messages. Run this once if the gateway
              had message history before the command center was installed. It is safe to repeat and never overwrites
              status, assignment or priority you have already set.
            </p>
            <button
              type="button"
              className="cc-btn"
              disabled={!canWrite || backfill.isPending}
              onClick={() =>
                backfill.mutate(undefined, {
                  onSuccess: result =>
                    success('Index rebuilt', `${result.created} created · ${result.updated} updated · ${result.contacts} contacts`),
                  onError: error => showError(error instanceof Error ? error.message : 'Backfill failed'),
                })
              }
            >
              {backfill.isPending ? <Loader2 size={13} className="cc-spin" /> : <Database size={13} />} Rebuild from message history
            </button>
          </div>
        </section>

        {/* ── Tools ──────────────────────────────────────────────── */}
        <section className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">
              <Wrench size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
              Tools
            </h2>
          </div>
          <div className="cc-card-body set-links">
            <p className="cc-hint" style={{ marginTop: 0 }}>
              Occasional tools, kept out of the sidebar so it stays about the daily work. Everything
              here still works exactly as before.
            </p>
            <Link to="/templates" className="set-link">
              <span>
                <ClipboardList size={13} /> Message templates
              </span>
              <ArrowRight size={13} />
            </Link>
            <Link to="/message-tester" className="set-link">
              <span>
                <Send size={13} /> Message tester
              </span>
              <ArrowRight size={13} />
            </Link>
            <Link to="/chats" className="set-link">
              <span>
                <MessageSquare size={13} /> Raw chat browser
              </span>
              <ArrowRight size={13} />
            </Link>
            <Link to="/sessions" className="set-link">
              <span>
                <Server size={13} /> Session internals
              </span>
              <ArrowRight size={13} />
            </Link>
            <Link to="/activity" className="set-link">
              <span>
                <FileText size={13} /> Activity log
              </span>
              <ArrowRight size={13} />
            </Link>
          </div>
        </section>

        {/* ── Admin ──────────────────────────────────────────────── */}
        {role === 'admin' && (
          <section className="cc-card">
            <div className="cc-card-head">
              <h2 className="cc-card-title">
                <ShieldCheck size={14} style={{ verticalAlign: '-2px', marginRight: '0.35rem' }} />
                Administration
              </h2>
            </div>
            <div className="cc-card-body set-links">
              <Link to="/api-keys" className="set-link">
                <span>
                  <Key size={13} /> API keys
                </span>
                <ArrowRight size={13} />
              </Link>
              <Link to="/webhooks" className="set-link">
                <span>
                  <Webhook size={13} /> Webhooks
                </span>
                <ArrowRight size={13} />
              </Link>
              <Link to="/infrastructure" className="set-link">
                <span>
                  <Server size={13} /> Infrastructure
                </span>
                <ArrowRight size={13} />
              </Link>
              <Link to="/plugins" className="set-link">
                <span>
                  <Puzzle size={13} /> Integrations &amp; plugins
                </span>
                <ArrowRight size={13} />
              </Link>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

export default CommandSettings;
