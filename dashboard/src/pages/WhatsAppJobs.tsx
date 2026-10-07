import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FileText,
  Loader2,
  RefreshCw,
  Send,
  XCircle,
  CheckCircle2,
  AlertTriangle,
  Play,
  BrainCircuit,
} from 'lucide-react';
import {
  request,
  whatsappJobApi,
  type WhatsAppDocumentJob,
  type DocumentTypeOption,
  type JobConnectionState,
  type DocumentTypeKpi,
} from '../services/api';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useRole } from '../hooks/useRole';
import { useToast } from '../hooks/useToast';
import { PageHeader } from '../components/PageHeader';
import { Modal } from '../components/Modal';
import { buildSendJob, canSend, needsDocumentNumber } from './sendJobRequest';
import { summariseReasoning, type ReasoningProviderStatus } from './reasoningHealth';
import './WhatsAppJobs.css';

/**
 * Phase 1: queue a document for WhatsApp delivery, and watch what happens to it.
 *
 * The send form only ever creates a job — it never calls WhatsApp. Everything after that is
 * the worker's, which is why this screen is mostly a window onto rows rather than a set of
 * controls: the interesting information is what the pipeline did, not what the operator can
 * make it do.
 */

const TERMINAL = new Set(['SENT', 'FAILED', 'CANCELLED']);

/** The eight stages §12 asks a timeline to show, in the order they happen. */
const STAGE_LABELS: Record<string, string> = {
  PENDING: 'Job created',
  CLAIMED: 'Job claimed by a worker',
  PROCESSING: 'Document type identified',
  FETCHING_DOCUMENT: 'Document API called',
  DOCUMENT_RECEIVED: 'Document received and validated',
  SENDING_TO_WHATSAPP: 'WhatsApp sending started',
  SENT: 'Document sent',
  RETRY_SCHEDULED: 'Retry scheduled',
  FAILED: 'Job failed',
  CANCELLED: 'Job cancelled',
};

function statusClass(status: string): string {
  if (status === 'SENT') return 'ok';
  if (status === 'FAILED') return 'bad';
  if (status === 'CANCELLED') return 'muted';
  if (status === 'RETRY_SCHEDULED') return 'warn';
  return 'busy';
}

function ms(value: number | null): string {
  if (value === null) return '—';
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

function elapsed(job: WhatsAppDocumentJob): string {
  const end = job.completedAt ?? job.sentAt;
  if (!end) return '—';
  return ms(new Date(end).getTime() - new Date(job.createdAt).getTime());
}

export function WhatsAppJobs() {
  useDocumentTitle('WhatsApp document delivery');
  const { isAdmin, isOperator } = useRole();
  const toast = useToast();
  const canWrite = isAdmin || isOperator;

  const [jobs, setJobs] = useState<WhatsAppDocumentJob[]>([]);
  const [types, setTypes] = useState<DocumentTypeOption[]>([]);
  const [connection, setConnection] = useState<JobConnectionState | null>(null);
  const [kpis, setKpis] = useState<DocumentTypeKpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<WhatsAppDocumentJob | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [reasoning, setReasoning] = useState<ReasoningProviderStatus[] | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [jobRows, connectionState, kpiRows] = await Promise.all([
        whatsappJobApi.list({ limit: 100 }),
        whatsappJobApi.connection(),
        whatsappJobApi.kpis(),
      ]);
      setJobs(jobRows);
      setConnection(connectionState);
      setKpis(kpiRows);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void refresh();
    void whatsappJobApi.documentTypes().then(setTypes).catch(() => undefined);
    /*
     * Which reasoner is answering clients. Its own request, not part of `refresh`: this screen
     * polls every two seconds while a job moves, and the answer changes on the scale of a
     * redeploy. A viewer key may read it, and a server too old to report it leaves it undefined,
     * which the panel reads as "not set up" rather than an error.
     */
    void request<{ reasoning?: ReasoningProviderStatus[] }>('/agent/status')
      .then(status => setReasoning(status.reasoning))
      .catch(() => undefined);
  }, [refresh]);

  /*
   * Polls while anything is still moving.
   *
   * A job goes through six states in a couple of seconds, and the whole value of this screen
   * during a demonstration is watching that happen rather than pressing refresh. Once every
   * job is terminal the timer stops, so an idle tab is not asking the server questions all day.
   */
  const anyInFlight = useMemo(() => jobs.some(j => !TERMINAL.has(j.status)), [jobs]);
  useEffect(() => {
    if (!anyInFlight) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [anyInFlight, refresh]);

  // Keep the open timeline in step with the polling above.
  useEffect(() => {
    if (!selected) return;
    const fresh = jobs.find(j => j.reference === selected.reference);
    if (fresh && fresh.status !== selected.status) setSelected(fresh);
  }, [jobs, selected]);

  const act = async (reference: string, action: 'retry' | 'cancel') => {
    setBusy(reference);
    try {
      const result = action === 'retry' ? await whatsappJobApi.retry(reference) : await whatsappJobApi.cancel(reference);
      toast.success(`${result.jobId} is now ${result.status}`);
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const runWorker = async () => {
    setBusy('worker');
    try {
      const { claimed } = await whatsappJobApi.runWorker();
      toast.success(claimed ? `Worker claimed ${claimed} job(s)` : 'Nothing waiting');
      await refresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="wa-jobs">
      <PageHeader
        title="WhatsApp document delivery"
        subtitle="Queue a document, and watch it travel from the request to the recipient."
        actions={
          canWrite ? (
            <>
              <button className="btn" onClick={runWorker} disabled={busy === 'worker'}>
                {busy === 'worker' ? <Loader2 className="spin" size={15} /> : <Play size={15} />} Run worker now
              </button>
              <button className="btn primary" onClick={() => setSendOpen(true)}>
                <Send size={15} /> Send to WhatsApp
              </button>
            </>
          ) : null
        }
      />

      <ConnectionPanel connection={connection} onRefresh={refresh} canWrite={canWrite} />

      <ReasoningPanel providers={reasoning} />

      {kpis.some(k => k.received > 0) && <KpiPanel kpis={kpis.filter(k => k.received > 0)} />}

      <section className="panel">
        <h2>Jobs</h2>
        {loading ? (
          <div className="empty"><Loader2 className="spin" size={18} /> loading…</div>
        ) : jobs.length === 0 ? (
          <div className="empty">No delivery jobs yet.</div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Job</th><th>Source</th><th>Document</th><th>Recipient</th>
                  <th>Status</th><th>Try</th><th>Created</th><th>Took</th><th>WhatsApp id</th><th></th>
                </tr>
              </thead>
              <tbody>
                {jobs.map(job => (
                  <tr key={job.id} className={job.status === 'FAILED' ? 'row-bad' : undefined}>
                    <td><button className="link" onClick={() => setSelected(job)}>{job.reference}</button></td>
                    <td className="dim">{job.source}</td>
                    <td>
                      <div>{job.documentReference ?? job.documentName ?? '—'}</div>
                      <div className="dim small">{job.documentType}</div>
                    </td>
                    <td>
                      <div>{job.recipientName ?? '—'}</div>
                      <div className="dim small">{job.recipientWhatsAppNumber}</div>
                    </td>
                    <td>
                      <span className={`tag ${statusClass(job.status)}`}>{job.status}</span>
                      {job.errorMessage && <div className="err small" title={job.errorMessage}>{job.errorCode}</div>}
                    </td>
                    <td className="dim">{job.attemptCount}/{job.maximumAttempts}</td>
                    <td className="dim small">{new Date(job.createdAt).toLocaleTimeString()}</td>
                    <td className="dim small">{elapsed(job)}</td>
                    <td className="dim small mono">{job.whatsappMessageId ?? '—'}</td>
                    <td className="actions">
                      {canWrite && job.status === 'FAILED' && (
                        <button className="btn tiny" onClick={() => void act(job.reference, 'retry')} disabled={busy === job.reference}>
                          <RefreshCw size={13} /> Retry
                        </button>
                      )}
                      {canWrite && !TERMINAL.has(job.status) && (
                        <button className="btn tiny" onClick={() => void act(job.reference, 'cancel')} disabled={busy === job.reference}>
                          <XCircle size={13} /> Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && <TimelineModal job={selected} onClose={() => setSelected(null)} />}
      {sendOpen && (
        <SendModal
          types={types}
          onClose={() => setSendOpen(false)}
          onCreated={async reference => {
            setSendOpen(false);
            toast.success(`${reference} created — the worker will pick it up`);
            await refresh();
          }}
        />
      )}
    </div>
  );
}

/** §11: connection state, queue depth and the last delivery. */
function ConnectionPanel({
  connection,
  onRefresh,
  canWrite,
}: {
  connection: JobConnectionState | null;
  onRefresh: () => Promise<void>;
  canWrite: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState<string | null>(null);

  const waitingForScan = connection?.state === 'QR_REQUIRED';

  /*
   * Pulls a fresh QR while one is being shown.
   *
   * WhatsApp rotates the code every twenty seconds or so and refuses an expired one, so a
   * QR fetched once and left on screen is a picture of something that no longer works —
   * the scan simply fails with no explanation. Polling faster than the rotation means the
   * code on screen is always the current one.
   */
  useEffect(() => {
    if (!waitingForScan) {
      setQr(null);
      return;
    }
    let live = true;
    const pull = () =>
      whatsappJobApi
        .qr()
        .then(result => {
          if (live) setQr(result.qr);
        })
        .catch(() => undefined);
    void pull();
    const timer = setInterval(pull, 15000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [waitingForScan]);

  if (!connection) return null;

  // Only the provider's own answer is ever shown as Connected — §11 is explicit about this.
  const connected = connection.state === 'CONNECTED';

  const sendTest = async () => {
    setBusy(true);
    try {
      const result = await whatsappJobApi.sendTestDocument();
      if (result.queued) toast.success(`${result.jobId} queued to ${result.to}`);
      else toast.error(result.message ?? `WhatsApp is ${result.state}`);
      await onRefresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = async (action: 'connect' | 'reconnect' | 'logout') => {
    setBusy(true);
    try {
      const { state } = await whatsappJobApi.connectionAction(action);
      toast.success(`WhatsApp is now ${state}`);
      await onRefresh();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel connection">
      <div className="conn-row">
        <div className={`conn-state ${connected ? 'ok' : connection.state === 'ERROR' ? 'bad' : 'warn'}`}>
          {connected ? <CheckCircle2 size={16} /> : <AlertTriangle size={16} />}
          <div>
            <strong>{connection.state}</strong>
            <div className="dim small">
              {connection.provider === 'mock'
                ? 'demonstration transport — messages are recorded, not transmitted'
                : `session ${connection.sessionId}`}
            </div>
          </div>
        </div>

        <div className="conn-stat"><span className="dim small">Pending</span><strong>{connection.pendingJobs}</strong></div>
        <div className="conn-stat"><span className="dim small">Sent</span><strong>{connection.sentJobs}</strong></div>
        <div className="conn-stat"><span className="dim small">Failed</span><strong>{connection.failedJobs}</strong></div>
        <div className="conn-stat">
          <span className="dim small">Worker</span>
          <strong>{connection.workerEnabled ? `every ${connection.pollIntervalSeconds}s` : 'manual'}</strong>
        </div>

        {canWrite && (
          <div className="conn-actions">
            {connection.provider !== 'mock' && (
              <>
                <button className="btn tiny" onClick={() => void run('connect')} disabled={busy}>Connect</button>
                <button className="btn tiny" onClick={() => void run('reconnect')} disabled={busy}>Reconnect</button>
                <button className="btn tiny" onClick={() => void run('logout')} disabled={busy}>Log out</button>
              </>
            )}
            {/* Addressed to the connected number itself — never a number typed into a box. */}
            <button className="btn tiny" onClick={() => void sendTest()} disabled={busy || !connected} title={connected ? 'Sends a test document to this device' : 'Connect first'}>
              Send test document
            </button>
          </div>
        )}
      </div>
      {waitingForScan && (
        <div className="qr-pane">
          {qr ? (
            <>
              <img src={qr} alt="WhatsApp pairing QR code" width={220} height={220} />
              <div>
                <strong>Scan to connect</strong>
                <ol className="dim small">
                  <li>WhatsApp → Settings → Linked devices</li>
                  <li>Link a device, then scan this code</li>
                  <li>The code refreshes on its own; scan whichever is on screen</li>
                </ol>
                <p className="dim small">
                  Use a <strong>separate test number</strong>, not the main business number.
                </p>
              </div>
            </>
          ) : (
            <div className="dim small"><Loader2 className="spin" size={14} /> waiting for a code…</div>
          )}
        </div>
      )}
      {connection.lastSuccessfulDelivery && (
        <div className="dim small last-sent">
          Last delivery: {connection.lastSuccessfulDelivery.documentName} ({connection.lastSuccessfulDelivery.jobId}) ·{' '}
          {connection.lastSuccessfulDelivery.sentAt && new Date(connection.lastSuccessfulDelivery.sentAt).toLocaleString()} ·{' '}
          <span className="mono">{connection.lastSuccessfulDelivery.whatsappMessageId}</span>
        </div>
      )}
    </section>
  );
}

/**
 * Whether the bot is understanding sentences, or has fallen back to fixed phrasings.
 *
 * The question clients notice first and the one the log answered only in a container. Shown
 * beside the connection because the two together are the whole "is it working" answer.
 */
function ReasoningPanel({ providers }: { providers: ReasoningProviderStatus[] | undefined }) {
  const health = summariseReasoning(providers);
  return (
    <section className="panel reasoning">
      <div className={`conn-state ${health.level === 'ok' ? 'ok' : health.level === 'degraded' ? 'bad' : 'warn'}`}>
        <BrainCircuit size={16} />
        <div>
          <strong>{health.headline}</strong>
          {health.advice && <div className="dim small">{health.advice}</div>}
        </div>
      </div>
    </section>
  );
}

/** §13: per-document-type KPIs, with the API and WhatsApp legs kept apart. */
function KpiPanel({ kpis }: { kpis: DocumentTypeKpi[] }) {
  return (
    <section className="panel">
      <h2>Performance by document type</h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Document type</th><th>Received</th><th>Sent</th><th>Failed</th><th>Undeliverable</th><th>Pipeline success</th><th>Overall</th>
              <th>Document API</th><th>WhatsApp</th><th>End to end</th><th>Target</th><th>Within SLA</th>
              <th>Retries</th><th>Timeouts</th><th>Duplicates stopped</th>
            </tr>
          </thead>
          <tbody>
            {kpis.map(k => (
              <tr key={k.documentType}>
                <td>{k.displayName}</td>
                <td>{k.received}</td>
                <td>{k.completed}</td>
                <td>{k.failed}</td>
                {/* Bad numbers and missing documents: nothing a retry could have fixed. */}
                <td className="dim" title="Failed for a reason no retry could fix — a number not on WhatsApp, a document that does not exist">
                  {k.undeliverable}
                </td>
                <td
                  className={
                    k.systemSuccessRatePercent !== null && k.systemSuccessRatePercent < k.targetSuccessRate ? 'err' : 'ok'
                  }
                  title="Success over the jobs the pipeline was responsible for — this is the one to hold at 100%"
                >
                  {k.systemSuccessRatePercent === null ? '—' : `${k.systemSuccessRatePercent}%`}
                </td>
                <td className="dim" title="Every job, including ones that were never deliverable">
                  {k.successRatePercent === null ? '—' : `${k.successRatePercent}%`}
                </td>
                <td>{ms(k.averageDocumentApiMs)}</td>
                <td>{ms(k.averageWhatsAppSendMs)}</td>
                <td>{ms(k.averageEndToEndMs)}</td>
                <td className="dim">{k.targetProcessingSeconds}s</td>
                <td>{k.slaCompliancePercent === null ? '—' : `${k.slaCompliancePercent}%`}</td>
                <td>{k.retryCount}</td>
                <td>{k.timeoutCount}</td>
                <td>{k.duplicatesPrevented}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** §12: the eight-stage timeline for one job. */
function TimelineModal({ job, onClose }: { job: WhatsAppDocumentJob; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title={`${job.reference} — ${job.documentReference ?? job.documentType}`}>
      <div className="timeline">
        {(job.timeline ?? []).map((entry, index) => (
          <div key={index} className={`t-row ${statusClass(entry.status)}`}>
            <div className="t-dot" />
            <div className="t-body">
              <div className="t-title">{STAGE_LABELS[entry.status] ?? entry.status}</div>
              {entry.detail && <div className="dim small">{entry.detail}</div>}
              <div className="dim small mono">{new Date(entry.at).toLocaleTimeString()}</div>
            </div>
          </div>
        ))}
      </div>
      <dl className="facts">
        <div><dt>Requested by</dt><dd>{job.requestedByUserId ?? '—'}</dd></div>
        <div><dt>Client</dt><dd>{job.clientId ?? '—'}</dd></div>
        <div><dt>Party</dt><dd>{job.partyId ?? '—'}</dd></div>
        <div><dt>Recipient</dt><dd>{job.recipientName ?? '—'} · {job.recipientWhatsAppNumber}</dd></div>
        <div><dt>Document</dt><dd>{job.documentName ?? '—'} {job.documentSize ? `· ${job.documentSize} bytes` : ''}</dd></div>
        <div><dt>WhatsApp id</dt><dd className="mono">{job.whatsappMessageId ?? '—'}</dd></div>
        <div><dt>End to end</dt><dd>{elapsed(job)}</dd></div>
        {job.errorMessage && <div><dt>Error</dt><dd className="err">{job.errorCode}: {job.errorMessage}</dd></div>}
      </dl>
    </Modal>
  );
}

/** A number the bot serves, and the Tijarah company whose documents it receives. */
interface RegisteredClient {
  whatsAppNo: string;
  displayName: string | null;
  sid: number;
  grp: string;
  aYear: string;
  isActive: boolean;
}

const ANOTHER_NUMBER = '';

/**
 * §5: the Send to WhatsApp form. Creates a job and nothing else.
 *
 * It starts empty on purpose. It used to open filled with sample values — invoice "INV-1001",
 * a made-up "saved number" — and anything sent without retyping every field went to a number
 * nobody owns, asking Tijarah for an invoice that does not exist (answered 400).
 */
function SendModal({
  types,
  onClose,
  onCreated,
}: {
  types: DocumentTypeOption[];
  onClose: () => void;
  onCreated: (reference: string) => Promise<void>;
}) {
  const toast = useToast();
  const enabled = types.filter(t => t.enabled);
  const [documentType, setDocumentType] = useState(enabled[0]?.documentType ?? 'invoice');
  const [documentNumber, setDocumentNumber] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [partyCode, setPartyCode] = useState('');
  const [clients, setClients] = useState<RegisteredClient[]>([]);
  const [clientPhone, setClientPhone] = useState(ANOTHER_NUMBER);
  const [alternate, setAlternate] = useState('');
  const [company, setCompany] = useState({ sid: '', grp: '', aYear: '' });
  const [recipientName, setRecipientName] = useState('');
  const [messageText, setMessageText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  /*
   * The registered clients are who documents normally go to, and choosing one also chooses
   * their company, so the document comes from that client's books rather than the default
   * company. The list is admin-only; any other key just gets the number field.
   */
  useEffect(() => {
    let live = true;
    request<RegisteredClient[]>('/bot-users')
      .then(rows => {
        if (live) setClients(rows.filter(r => r.isActive));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const selectedType = enabled.find(t => t.documentType === documentType);
  const needsNumber = needsDocumentNumber(selectedType);
  const optional = selectedType?.optionalParameters ?? [];
  const client = clients.find(c => c.whatsAppNo === clientPhone);
  const number = client ? client.whatsAppNo : alternate;
  const tenant = client ? { sid: String(client.sid), grp: client.grp, aYear: client.aYear } : company;
  const ready = !!selectedType && canSend({ type: selectedType, documentNumber, number });

  const submit = async () => {
    if (!selectedType) return;
    setSubmitting(true);
    try {
      const result = await whatsappJobApi.create(
        buildSendJob({
          type: selectedType,
          documentNumber,
          from,
          to,
          partyCode,
          tenant,
          number,
          recipientName: recipientName.trim() || client?.displayName || '',
          messageText,
        }),
      );
      await onCreated(result.jobId);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Send to WhatsApp">
      <div className="send-form">
        <label>
          <span>Document type</span>
          <select value={documentType} onChange={e => setDocumentType(e.target.value)}>
            {enabled.map(t => (
              <option key={t.documentType} value={t.documentType}>
                {t.displayName}
              </option>
            ))}
          </select>
        </label>
        {needsNumber ? (
          <label>
            <span>Document number</span>
            <input
              value={documentNumber}
              onChange={e => setDocumentNumber(e.target.value)}
              placeholder="e.g. 179 — the number shown in Tijarah"
              inputMode="numeric"
            />
          </label>
        ) : (
          <>
            {(optional.includes('from') || optional.includes('to')) && (
              <div className="two">
                <label>
                  <span>From</span>
                  <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
                </label>
                <label>
                  <span>To</span>
                  <input type="date" value={to} onChange={e => setTo(e.target.value)} />
                </label>
              </div>
            )}
            {optional.includes('partyCode') && (
              <label>
                <span>Party code (optional)</span>
                <input
                  value={partyCode}
                  onChange={e => setPartyCode(e.target.value)}
                  placeholder="Leave blank for every party"
                />
              </label>
            )}
          </>
        )}
        {clients.length > 0 && (
          <label>
            <span>Send to</span>
            <select value={clientPhone} onChange={e => setClientPhone(e.target.value)}>
              <option value={ANOTHER_NUMBER}>Another number…</option>
              {clients.map(c => (
                <option key={c.whatsAppNo} value={c.whatsAppNo}>
                  {c.displayName || c.whatsAppNo} · +{c.whatsAppNo} (company {c.sid}/{c.grp})
                </option>
              ))}
            </select>
          </label>
        )}
        {!client && (
          <>
            <label>
              <span>WhatsApp number</span>
              <input
                placeholder="+923001234567"
                value={alternate}
                onChange={e => setAlternate(e.target.value)}
                inputMode="tel"
              />
            </label>
            <div className="two" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
              <label>
                <span>Company (sid)</span>
                <input
                  value={company.sid}
                  onChange={e => setCompany({ ...company, sid: e.target.value })}
                  placeholder="default"
                />
              </label>
              <label>
                <span>Branch</span>
                <input
                  value={company.grp}
                  onChange={e => setCompany({ ...company, grp: e.target.value })}
                  placeholder="default"
                />
              </label>
              <label>
                <span>Year</span>
                <input
                  value={company.aYear}
                  onChange={e => setCompany({ ...company, aYear: e.target.value })}
                  placeholder="default"
                />
              </label>
            </div>
          </>
        )}
        <label>
          <span>Recipient name (optional)</span>
          <input
            value={recipientName}
            onChange={e => setRecipientName(e.target.value)}
            placeholder={client?.displayName ?? ''}
          />
        </label>
        <label>
          <span>Message / caption (optional)</span>
          <textarea
            rows={3}
            maxLength={1024}
            value={messageText}
            onChange={e => setMessageText(e.target.value)}
            placeholder="Leave blank for the standard caption"
          />
        </label>

        <p className="dim small">
          <FileText size={13} /> This creates a delivery job. A background worker fetches the document from the
          configured API and sends it — nothing is sent from this screen.
        </p>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void submit()} disabled={submitting || !ready}>
            {submitting ? <Loader2 className="spin" size={15} /> : <Send size={15} />} Send request
          </button>
        </div>
      </div>
    </Modal>
  );
}

export default WhatsAppJobs;
