import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Search, UserCheck, UserPlus, X } from 'lucide-react';
import { request } from '../../services/api';

/** A number the bot serves, and the Tijarah company whose books it may see. */
interface BotClient {
  whatsAppNo: string;
  displayName: string | null;
  sid: number;
  grp: string;
  aYear: string;
  isActive: boolean;
}

/** One entry in Tijarah's own client directory. */
interface DirectoryEntry {
  sid: number;
  grp: string;
  cont: string | null;
  businessName: string | null;
}

const clientsKey = ['tijarah', 'bot-users'] as const;

/** `923302417530@c.us` → `923302417530`. Groups and broadcast lists are never clients. */
function phoneOf(chatId: string): string | null {
  const [user, server] = chatId.split('@');
  return server === 'c.us' || server === 's.whatsapp.net' ? user.replace(/\D/g, '') : null;
}

/**
 * Whether the person in this chat is a Tijarah client — and the way to make them one.
 *
 * The bot answers clients only; everyone else is left to the team. So "is this a client?" is the
 * first thing an operator needs on a chat the bot has gone quiet in, and "make them one" belongs
 * right beside it rather than behind a curl command. The company can be filled from Tijarah's
 * own directory, because guessing a company id is how one client gets shown another's books.
 *
 * Hidden for a key that cannot read the client list: registering a number maps it to a company's
 * books, so it is an administrator's action.
 */
export function TijarahClientSection({ chatId }: { chatId: string }) {
  const phone = phoneOf(chatId);
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ sid: '', grp: 'GR', aYear: String(new Date().getFullYear()), name: '' });
  const [matches, setMatches] = useState<DirectoryEntry[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const clients = useQuery({
    queryKey: clientsKey,
    queryFn: () => request<BotClient[]>('/bot-users'),
    staleTime: 30_000,
    retry: false,
    enabled: phone !== null,
  });

  const lookup = useMutation({
    mutationFn: () => request<DirectoryEntry[]>(`/bot-users/lookup?phone=${encodeURIComponent(phone ?? '')}`),
    onSuccess: rows => {
      setMatches(rows);
      if (rows.length === 1) choose(rows[0]);
    },
    onError: () => setProblem('Could not reach the Tijarah directory.'),
  });

  const save = useMutation({
    mutationFn: () =>
      request<BotClient>('/bot-users', {
        method: 'PUT',
        body: JSON.stringify({
          whatsAppNo: phone,
          sid: Number(form.sid),
          grp: form.grp.trim(),
          aYear: form.aYear.trim(),
          displayName: form.name.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      setAdding(false);
      setMatches(null);
      void queryClient.invalidateQueries({ queryKey: clientsKey });
    },
    onError: (error: unknown) => setProblem(error instanceof Error ? error.message : 'Could not save.'),
  });

  const remove = useMutation({
    mutationFn: () => request<unknown>(`/bot-users/${encodeURIComponent(phone ?? '')}`, { method: 'DELETE' }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: clientsKey }),
  });

  function choose(entry: DirectoryEntry) {
    setForm(f => ({ ...f, sid: String(entry.sid), grp: entry.grp, name: entry.businessName ?? f.name }));
  }

  if (!phone || clients.isError) return null;

  const client = clients.data?.find(c => c.whatsAppNo === phone && c.isActive);
  const valid = /^\d+$/.test(form.sid) && Number(form.sid) > 0 && form.grp.trim() !== '' && /^\d{4}/.test(form.aYear);

  return (
    <section className="inbox-cust-section">
      <p className="cc-label">Tijarah client</p>

      {clients.isLoading ? (
        <span className="cc-muted">Checking…</span>
      ) : client ? (
        <div className="cc-stack" style={{ gap: '0.4rem' }}>
          <span className="cc-row" style={{ gap: '0.4rem' }}>
            <UserCheck size={16} aria-hidden />
            <strong>{client.displayName || 'Registered client'}</strong>
          </span>
          <span className="cc-hint">
            Company {client.sid} / {client.grp} · year {client.aYear}. The bot answers this number.
          </span>
          <div>
            <button
              type="button"
              className="cc-btn cc-btn-sm cc-btn-danger"
              onClick={() => {
                if (window.confirm('Stop the bot serving this number? Their chats stay in the inbox.')) remove.mutate();
              }}
              disabled={remove.isPending}
            >
              {remove.isPending ? <Loader2 size={14} className="cc-spin" /> : <X size={14} />} Remove client
            </button>
          </div>
        </div>
      ) : !adding ? (
        <div className="cc-stack" style={{ gap: '0.4rem' }}>
          <span className="cc-hint">Not a client — the bot stays silent here and leaves this chat to the team.</span>
          <div>
            <button
              type="button"
              className="cc-btn cc-btn-primary cc-btn-sm"
              onClick={() => {
                setAdding(true);
                setProblem(null);
                lookup.mutate();
              }}
            >
              <UserPlus size={14} /> Add as client
            </button>
          </div>
        </div>
      ) : (
        <div className="cc-stack" style={{ gap: '0.5rem' }}>
          {lookup.isPending ? (
            <span className="cc-muted">
              <Loader2 size={14} className="cc-spin" /> Looking this number up in Tijarah…
            </span>
          ) : matches && matches.length > 1 ? (
            <div className="cc-stack" style={{ gap: '0.3rem' }}>
              <span className="cc-hint">This number is on several Tijarah accounts. Pick one:</span>
              {matches.map(m => (
                <button
                  type="button"
                  key={`${m.sid}-${m.grp}`}
                  className="cc-btn cc-btn-ghost cc-btn-sm"
                  onClick={() => choose(m)}
                >
                  {m.businessName || `Account ${m.sid}`} ({m.sid}/{m.grp})
                </button>
              ))}
            </div>
          ) : matches && matches.length === 0 ? (
            <span className="cc-hint">Not found in Tijarah's directory — enter the company yourself.</span>
          ) : matches && matches.length === 1 ? (
            <span className="cc-hint">Found in Tijarah: {matches[0].businessName || `account ${matches[0].sid}`}.</span>
          ) : null}

          <label className="cc-stack" style={{ gap: '0.2rem' }}>
            <span className="cc-hint">Business name</span>
            <input
              className="cc-input"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              placeholder="Shown to your team"
            />
          </label>
          <div className="cc-row" style={{ gap: '0.4rem' }}>
            <label className="cc-stack" style={{ gap: '0.2rem', flex: 1 }}>
              <span className="cc-hint">Company (sid)</span>
              <input
                className="cc-input"
                inputMode="numeric"
                value={form.sid}
                onChange={e => setForm({ ...form, sid: e.target.value })}
              />
            </label>
            <label className="cc-stack" style={{ gap: '0.2rem', flex: 1 }}>
              <span className="cc-hint">Group</span>
              <input className="cc-input" value={form.grp} onChange={e => setForm({ ...form, grp: e.target.value })} />
            </label>
            <label className="cc-stack" style={{ gap: '0.2rem', flex: 1 }}>
              <span className="cc-hint">Year</span>
              <input
                className="cc-input"
                inputMode="numeric"
                value={form.aYear}
                onChange={e => setForm({ ...form, aYear: e.target.value })}
              />
            </label>
          </div>

          {problem ? <span className="cc-hint" role="alert">{problem}</span> : null}

          <div className="cc-row" style={{ gap: '0.4rem' }}>
            <button
              type="button"
              className="cc-btn cc-btn-primary cc-btn-sm"
              disabled={!valid || save.isPending}
              onClick={() => {
                setProblem(null);
                save.mutate();
              }}
            >
              {save.isPending ? <Loader2 size={14} className="cc-spin" /> : <UserCheck size={14} />} Save client
            </button>
            <button
              type="button"
              className="cc-btn cc-btn-ghost cc-btn-sm"
              onClick={() => {
                setProblem(null);
                lookup.mutate();
              }}
              disabled={lookup.isPending}
            >
              <Search size={14} /> Look up again
            </button>
            <button type="button" className="cc-btn cc-btn-ghost cc-btn-sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
