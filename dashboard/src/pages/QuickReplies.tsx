import { useMemo, useState } from 'react';
import { Folder, Loader2, Pencil, Plus, Sparkles, Trash2, Zap } from 'lucide-react';
import { useQuickRepliesQuery, useQuickReplyMutations } from '../hooks/commandCenter';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { EmptyState, ErrorState, Skeleton } from '../components/cc/Primitives';
import type { QuickReply } from '../services/commandCenter';
import './QuickReplies.css';

const VARIABLES = ['{{name}}', '{{phone}}', '{{agent_name}}'];

interface DraftState {
  id: string | null;
  shortcut: string;
  title: string;
  body: string;
  folder: string;
}

const EMPTY_DRAFT: DraftState = { id: null, shortcut: '', title: '', body: '', folder: 'General' };

/**
 * Saved replies.
 *
 * The editor previews the shortcut exactly as the composer will show it and highlights which
 * variables the text uses, because a reply whose placeholder is misspelled fails silently at the
 * moment it matters — in front of a customer.
 */
export function QuickReplies() {
  useDocumentTitle('Quick Replies');
  const { success, error: showError } = useToast();
  const { canWrite } = useRole();

  const repliesQuery = useQuickRepliesQuery();
  const mutations = useQuickReplyMutations();

  const [draft, setDraft] = useState<DraftState | null>(null);
  const [folderFilter, setFolderFilter] = useState('');

  const replies = useMemo(() => repliesQuery.data ?? [], [repliesQuery.data]);
  const folders = useMemo(
    () => [...new Set(replies.map(reply => reply.folder))].sort((a, b) => a.localeCompare(b)),
    [replies],
  );
  const visible = useMemo(
    () => (folderFilter ? replies.filter(reply => reply.folder === folderFilter) : replies),
    [replies, folderFilter],
  );
  const grouped = useMemo(() => {
    const map = new Map<string, QuickReply[]>();
    for (const reply of visible) {
      const list = map.get(reply.folder) ?? [];
      list.push(reply);
      map.set(reply.folder, list);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [visible]);

  const usedVariables = useMemo(() => {
    if (!draft) return [];
    return VARIABLES.filter(variable => draft.body.includes(variable));
  }, [draft]);

  const save = () => {
    if (!draft) return;
    const payload = {
      shortcut: draft.shortcut,
      title: draft.title,
      body: draft.body,
      folder: draft.folder || 'General',
    };
    const handlers = {
      onSuccess: () => {
        success(draft.id ? 'Quick reply updated' : 'Quick reply created');
        setDraft(null);
      },
      onError: (error: unknown) =>
        showError(error instanceof Error ? error.message : 'Could not save that quick reply'),
    };
    if (draft.id) mutations.update.mutate({ id: draft.id, ...payload }, handlers);
    else mutations.create.mutate(payload, handlers);
  };

  return (
    <div className="cc-page qr">
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">Quick Replies</h1>
          <p className="cc-page-sub">
            Saved answers your team inserts by typing <code>/shortcut</code> in the composer. Variables are filled from
            the conversation before the message is sent.
          </p>
        </div>
        <div className="cc-row">
          {replies.length === 0 && canWrite && (
            <button
              type="button"
              className="cc-btn"
              disabled={mutations.seed.isPending}
              onClick={() =>
                mutations.seed.mutate(undefined, {
                  onSuccess: result => success(`Added ${result.created} starter replies`),
                })
              }
            >
              {mutations.seed.isPending ? <Loader2 size={14} className="cc-spin" /> : <Sparkles size={14} />}
              Add starter set
            </button>
          )}
          <button
            type="button"
            className="cc-btn cc-btn-primary"
            onClick={() => setDraft({ ...EMPTY_DRAFT })}
            disabled={!canWrite}
          >
            <Plus size={14} /> New reply
          </button>
        </div>
      </header>

      {folders.length > 1 && (
        <div className="qr-folders">
          <button
            type="button"
            className={`qr-folder ${folderFilter === '' ? 'is-active' : ''}`}
            onClick={() => setFolderFilter('')}
          >
            All
          </button>
          {folders.map(folder => (
            <button
              key={folder}
              type="button"
              className={`qr-folder ${folderFilter === folder ? 'is-active' : ''}`}
              onClick={() => setFolderFilter(folder)}
            >
              <Folder size={12} /> {folder}
            </button>
          ))}
        </div>
      )}

      <div className="qr-layout">
        <div className="qr-list">
          {repliesQuery.isLoading ? (
            <div className="cc-stack">
              <Skeleton height={72} radius="var(--cc-radius-lg)" />
              <Skeleton height={72} radius="var(--cc-radius-lg)" />
            </div>
          ) : repliesQuery.error ? (
            <ErrorState error={repliesQuery.error} onRetry={() => void repliesQuery.refetch()} />
          ) : replies.length === 0 ? (
            <div className="cc-card">
              <EmptyState
                icon={<Zap size={20} />}
                title="No quick replies yet"
                description="Create the answers your team sends most often. Typing / in the composer brings them up instantly."
                action={
                  canWrite ? (
                    <button type="button" className="cc-btn cc-btn-primary cc-btn-sm" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
                      <Plus size={13} /> Create the first one
                    </button>
                  ) : undefined
                }
              />
            </div>
          ) : (
            grouped.map(([folder, items]) => (
              <section key={folder} className="qr-group">
                <p className="cc-label">
                  <Folder size={11} style={{ marginRight: '0.25rem', verticalAlign: '-1px' }} />
                  {folder}
                </p>
                <div className="qr-cards">
                  {items.map(reply => (
                    <article key={reply.id} className="cc-card qr-card">
                      <div className="qr-card-head">
                        <span className="qr-card-shortcut">/{reply.shortcut}</span>
                        <span className="qr-card-title cc-truncate">{reply.title}</span>
                        <span className="qr-card-uses cc-num" title="Times inserted">
                          {reply.useCount}×
                        </span>
                        <button
                          type="button"
                          className="cc-btn cc-btn-ghost cc-btn-sm"
                          onClick={() =>
                            setDraft({
                              id: reply.id,
                              shortcut: reply.shortcut,
                              title: reply.title,
                              body: reply.body,
                              folder: reply.folder,
                            })
                          }
                          disabled={!canWrite}
                          aria-label={`Edit ${reply.title}`}
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          type="button"
                          className="cc-btn cc-btn-ghost cc-btn-sm"
                          onClick={() =>
                            mutations.remove.mutate(reply.id, {
                              onSuccess: () => success('Quick reply deleted'),
                            })
                          }
                          disabled={!canWrite}
                          aria-label={`Delete ${reply.title}`}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                      <p className="qr-card-body">{reply.body}</p>
                    </article>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>

        {draft && (
          <aside className="cc-card qr-editor">
            <div className="cc-card-head">
              <h2 className="cc-card-title">{draft.id ? 'Edit reply' : 'New reply'}</h2>
            </div>
            <div className="cc-card-body">
              <label className="cc-field">
                <span>Shortcut</span>
                <div className="qr-shortcut-input">
                  <span>/</span>
                  <input
                    className="cc-input"
                    value={draft.shortcut}
                    placeholder="price"
                    onChange={event => setDraft({ ...draft, shortcut: event.target.value })}
                  />
                </div>
                <p className="cc-hint">Letters, numbers, hyphens and underscores. Typed after / in the composer.</p>
              </label>

              <label className="cc-field">
                <span>Title</span>
                <input
                  className="cc-input"
                  value={draft.title}
                  placeholder="Pricing enquiry"
                  onChange={event => setDraft({ ...draft, title: event.target.value })}
                />
              </label>

              <label className="cc-field">
                <span>Folder</span>
                <input
                  className="cc-input"
                  value={draft.folder}
                  list="qr-folder-options"
                  onChange={event => setDraft({ ...draft, folder: event.target.value })}
                />
                <datalist id="qr-folder-options">
                  {folders.map(folder => (
                    <option key={folder} value={folder} />
                  ))}
                </datalist>
              </label>

              <label className="cc-field">
                <span>Message</span>
                <textarea
                  className="cc-textarea"
                  rows={7}
                  value={draft.body}
                  placeholder="Hi {{name}}, thanks for asking about pricing…"
                  onChange={event => setDraft({ ...draft, body: event.target.value })}
                />
              </label>

              <p className="cc-label">Variables</p>
              <div className="qr-vars">
                {VARIABLES.map(variable => (
                  <button
                    key={variable}
                    type="button"
                    className={`qr-var ${usedVariables.includes(variable) ? 'is-used' : ''}`}
                    onClick={() => setDraft({ ...draft, body: `${draft.body}${variable}` })}
                  >
                    {variable}
                  </button>
                ))}
              </div>
              <p className="cc-hint">
                Click to insert. A variable the conversation cannot fill is left visible in the composer so it is
                corrected before sending, never silently blanked.
              </p>

              <div className="cc-row" style={{ gap: '0.4rem', marginTop: '1rem' }}>
                <button
                  type="button"
                  className="cc-btn cc-btn-primary"
                  onClick={save}
                  disabled={!draft.shortcut.trim() || !draft.title.trim() || !draft.body.trim() || mutations.create.isPending || mutations.update.isPending}
                >
                  {mutations.create.isPending || mutations.update.isPending ? <Loader2 size={13} className="cc-spin" /> : null}
                  {draft.id ? 'Save changes' : 'Create reply'}
                </button>
                <button type="button" className="cc-btn" onClick={() => setDraft(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

export default QuickReplies;
