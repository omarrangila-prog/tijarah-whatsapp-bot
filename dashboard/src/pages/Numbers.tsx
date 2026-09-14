import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Loader2,
  LogOut,
  Plus,
  Power,
  QrCode,
  RefreshCw,
  Smartphone,
  Trash2,
  X,
} from 'lucide-react';
import { sessionApi, type Session } from '../services/api';
import { useAnalyticsQuery } from '../hooks/commandCenter';
import { useSessionsQuery } from '../hooks/queries';
import { useWebSocket } from '../hooks/useWebSocket';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { useRole } from '../hooks/useRole';
import { EmptyState, ErrorState, HealthDot, Skeleton } from '../components/cc/Primitives';
import { isSessionStarted } from '../utils/sessionActions';
import { absoluteTime, formatCount, relativeTime } from '../utils/ccFormat';
import './Numbers.css';

/** Statuses that mean a QR scan is what the operator is waiting for. */
const NEEDS_QR = new Set(['qr_ready', 'initializing', 'authenticating']);

/**
 * WhatsApp number control.
 *
 * A management surface over the existing session endpoints — nothing about the engine or the
 * lifecycle is reimplemented here, and every button maps to a route that already exists. Secrets
 * are never rendered: the card shows status, health and volume, not credentials.
 */
export function Numbers() {
  useDocumentTitle('WhatsApp Numbers');
  const { success, error: showError } = useToast();
  const { canWrite } = useRole();

  const sessionsQuery = useSessionsQuery();
  const analyticsQuery = useAnalyticsQuery({ range: 'today' });

  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [qrFor, setQrFor] = useState<string | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const todayBySession = useMemo(
    () => new Map((analyticsQuery.data?.topSessions ?? []).map(row => [row.sessionId, row])),
    [analyticsQuery.data],
  );

  // Live status + QR over the existing socket, so a scan updates the card the moment it lands
  // rather than on the next poll.
  const { subscribe, isConnected } = useWebSocket({
    onSessionStatus: () => void sessionsQuery.refetch(),
    onQRCode: event => {
      if (event.sessionId === qrFor) {
        setQrCode(event.qrCode);
        setQrError(null);
      }
    },
  });

  useEffect(() => {
    if (!isConnected) return;
    subscribe('*', ['session.status', 'session.qr']);
    for (const session of sessions) subscribe(session.id, ['session.status', 'session.qr']);
  }, [isConnected, sessions, subscribe]);

  // Fetch the current QR when the modal opens; the socket then keeps it fresh as WhatsApp rotates it.
  useEffect(() => {
    if (!qrFor) {
      setQrCode(null);
      setQrError(null);
      return;
    }
    let active = true;
    sessionApi
      .getQR(qrFor)
      .then(result => {
        if (active) setQrCode(result.qrCode);
      })
      .catch((error: unknown) => {
        if (active) setQrError(error instanceof Error ? error.message : 'No QR code available yet');
      });
    return () => {
      active = false;
    };
  }, [qrFor]);

  const run = async (id: string, label: string, action: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await action();
      success(label);
      await sessionsQuery.refetch();
    } catch (error) {
      showError(error instanceof Error ? error.message : `Could not ${label.toLowerCase()}`);
    } finally {
      setBusy(null);
    }
  };

  const createSession = async () => {
    if (!newName.trim()) return;
    setBusy('new');
    try {
      const session = await sessionApi.create(newName.trim());
      success('Number created', 'Start it and scan the QR code to connect.');
      setNewName('');
      setCreating(false);
      await sessionsQuery.refetch();
      // Start it immediately — a created-but-stopped session cannot show a QR, which is the very
      // next thing the operator needs.
      await sessionApi.start(session.id).catch(() => undefined);
      setQrFor(session.id);
      await sessionsQuery.refetch();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Could not create the number');
    } finally {
      setBusy(null);
    }
  };

  const uptimeOf = (session: Session): string =>
    session.connectedAt ? `connected ${relativeTime(session.connectedAt)} ago` : 'not connected';

  return (
    <div className="cc-page num">
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">WhatsApp Numbers</h1>
          <p className="cc-page-sub">
            Every number your business runs, its connection health, and today's volume. Conversations from all of them
            land in one inbox.
          </p>
        </div>
        <button type="button" className="cc-btn cc-btn-primary" onClick={() => setCreating(true)} disabled={!canWrite}>
          <Plus size={14} /> Add a number
        </button>
      </header>

      {creating && (
        <div className="cc-card num-create">
          <div className="cc-card-body cc-row" style={{ gap: '0.5rem' }}>
            <input
              className="cc-input"
              placeholder="Name this number, e.g. Sales Line"
              value={newName}
              onChange={event => setNewName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void createSession();
              }}
              autoFocus
            />
            <button type="button" className="cc-btn cc-btn-primary" onClick={() => void createSession()} disabled={!newName.trim() || busy === 'new'}>
              {busy === 'new' ? <Loader2 size={13} className="cc-spin" /> : null} Create &amp; connect
            </button>
            <button type="button" className="cc-btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {sessionsQuery.isLoading ? (
        <div className="num-grid">
          {Array.from({ length: 3 }, (_, index) => (
            <Skeleton key={index} height={190} radius="var(--cc-radius-lg)" />
          ))}
        </div>
      ) : sessionsQuery.error ? (
        <ErrorState error={sessionsQuery.error} onRetry={() => void sessionsQuery.refetch()} />
      ) : sessions.length === 0 ? (
        <div className="cc-card">
          <EmptyState
            icon={<Smartphone size={22} />}
            title="No WhatsApp numbers yet"
            description="Add your first number, scan the QR code from WhatsApp on your phone, and conversations start flowing into the inbox."
            action={
              canWrite ? (
                <button type="button" className="cc-btn cc-btn-primary cc-btn-sm" onClick={() => setCreating(true)}>
                  <Plus size={13} /> Add a number
                </button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div className="num-grid">
          {sessions.map(session => {
            const started = isSessionStarted(session);
            const today = todayBySession.get(session.id);
            const isBusy = busy === session.id;
            return (
              <article key={session.id} className={`cc-card num-card status-${session.status}`}>
                <div className="num-card-head">
                  <span className="num-icon">
                    <Smartphone size={17} />
                  </span>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <h3 className="num-name cc-truncate">{session.name}</h3>
                    <p className="num-phone cc-num">{session.phone ? `+${session.phone}` : 'Not linked yet'}</p>
                  </div>
                  <span className="num-status">
                    <HealthDot status={session.status} />
                    {session.status.replace(/_/g, ' ')}
                  </span>
                </div>

                {session.restriction && (
                  <p className="num-warning">
                    <AlertTriangle size={12} />
                    WhatsApp has restricted this account ({session.restriction.kind.replace(/_/g, ' ')})
                    {session.restriction.expiresAt ? ` until ${absoluteTime(session.restriction.expiresAt)}` : ''}.
                  </p>
                )}
                {session.lastError && !session.restriction && (
                  <p className="num-warning">
                    <AlertTriangle size={12} />
                    {session.lastError}
                  </p>
                )}

                <dl className="num-stats">
                  <div>
                    <dt>Messages today</dt>
                    <dd className="cc-num">{today ? formatCount(today.inbound + today.outbound) : '0'}</dd>
                  </div>
                  <div>
                    <dt>Uptime</dt>
                    <dd>{uptimeOf(session)}</dd>
                  </div>
                  <div>
                    <dt>Last activity</dt>
                    <dd>{session.lastActive ? relativeTime(session.lastActive) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Engine</dt>
                    <dd>{session.pushName || 'Not linked'}</dd>
                  </div>
                </dl>

                <div className="num-actions">
                  {!started ? (
                    <button
                      type="button"
                      className="cc-btn cc-btn-primary cc-btn-sm"
                      onClick={() => void run(session.id, 'Number started', () => sessionApi.start(session.id))}
                      disabled={!canWrite || isBusy}
                    >
                      {isBusy ? <Loader2 size={12} className="cc-spin" /> : <Power size={12} />} Connect
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="cc-btn cc-btn-sm"
                      onClick={() => void run(session.id, 'Number stopped', () => sessionApi.stop(session.id))}
                      disabled={!canWrite || isBusy}
                    >
                      {isBusy ? <Loader2 size={12} className="cc-spin" /> : <Power size={12} />} Disconnect
                    </button>
                  )}

                  {NEEDS_QR.has(session.status) && (
                    <button type="button" className="cc-btn cc-btn-sm" onClick={() => setQrFor(session.id)} disabled={!canWrite}>
                      <QrCode size={12} /> Show QR
                    </button>
                  )}

                  <button
                    type="button"
                    className="cc-btn cc-btn-sm"
                    onClick={() =>
                      void run(session.id, 'Number restarted', async () => {
                        await sessionApi.stop(session.id).catch(() => undefined);
                        return sessionApi.start(session.id);
                      })
                    }
                    disabled={!canWrite || isBusy}
                    title="Stop and start this number"
                  >
                    <RefreshCw size={12} /> Restart
                  </button>

                  <button
                    type="button"
                    className="cc-btn cc-btn-sm"
                    onClick={() => void run(session.id, 'Logged out of WhatsApp', () => sessionApi.logout(session.id))}
                    disabled={!canWrite || isBusy}
                    title="Unlink this number from WhatsApp — a new QR scan will be required"
                  >
                    <LogOut size={12} /> Log out
                  </button>

                  <button
                    type="button"
                    className="cc-btn cc-btn-sm cc-btn-danger"
                    onClick={() => {
                      if (window.confirm(`Delete "${session.name}"? Its conversations and messages are removed too.`)) {
                        void run(session.id, 'Number deleted', () => sessionApi.delete(session.id));
                      }
                    }}
                    disabled={!canWrite || isBusy}
                    aria-label={`Delete ${session.name}`}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {qrFor && (
        <div className="num-qr-backdrop" role="dialog" aria-modal="true" aria-label="Scan QR code" onClick={() => setQrFor(null)}>
          <div className="cc-card num-qr" onClick={event => event.stopPropagation()}>
            <div className="cc-card-head">
              <h2 className="cc-card-title">Scan to connect</h2>
              <button type="button" className="cc-btn cc-btn-ghost cc-btn-icon" onClick={() => setQrFor(null)} aria-label="Close">
                <X size={16} />
              </button>
            </div>
            <div className="cc-card-body num-qr-body">
              {qrError ? (
                <ErrorState error={qrError} />
              ) : !qrCode ? (
                <div className="num-qr-loading">
                  <Loader2 size={22} className="cc-spin" />
                  <p>Waiting for a QR code…</p>
                </div>
              ) : (
                <img src={qrCode} alt="WhatsApp QR code" className="num-qr-img" />
              )}
              <ol className="num-qr-steps">
                <li>Open WhatsApp on the phone for this number.</li>
                <li>
                  Go to <strong>Settings → Linked devices → Link a device</strong>.
                </li>
                <li>Point the camera at this code.</li>
              </ol>
              <p className="cc-hint">The code refreshes automatically until the number connects.</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Numbers;
