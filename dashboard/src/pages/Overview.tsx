import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Inbox as InboxIcon,
  Loader2,
  MessageSquare,
  Smartphone,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAnalyticsQuery, useBackfillMutation, useConversationsQuery } from '../hooks/commandCenter';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useToast } from '../hooks/useToast';
import { Avatar, EmptyState, ErrorState, HealthDot, KpiCard, Skeleton } from '../components/cc/Primitives';
import { formatBucketLabel, formatCount, formatHour, formatMinutes, formatWaId, relativeTime } from '../utils/ccFormat';
import './Overview.css';

const STATUS_COLORS: Record<string, string> = {
  open: '#2563eb',
  waiting: '#7c3aed',
  resolved: '#059669',
};

/**
 * The command center's front page.
 *
 * Every number here is computed from stored data — there is no sample data and no placeholder. Where
 * a metric genuinely has nothing behind it (no conversation has been answered yet, so there is no
 * first-response time) the card shows an em dash and says why, rather than a zero that would read as
 * an achievement.
 */
export function Overview() {
  useDocumentTitle('Overview');
  const { success, error: showError } = useToast();
  const [range, setRange] = useState<'today' | '7d' | '30d'>('7d');

  const analyticsQuery = useAnalyticsQuery({ range });
  const sessionsQuery = useSessionsQuery();
  const recentQuery = useConversationsQuery({ limit: 8 });
  const backfill = useBackfillMutation();

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const data = analyticsQuery.data;
  const kpis = data?.kpis;

  const series = useMemo(
    () => (data?.timeSeries ?? []).map(point => ({ ...point, label: formatBucketLabel(point.bucket) })),
    [data?.timeSeries],
  );
  const statusData = useMemo(() => (data?.byStatus ?? []).filter(entry => entry.count > 0), [data?.byStatus]);
  const hours = useMemo(
    () => (data?.busiestHours ?? []).map(entry => ({ ...entry, label: formatHour(entry.hour) })),
    [data?.busiestHours],
  );

  const hasAnyData = (kpis?.messages ?? 0) > 0 || (recentQuery.data?.total ?? 0) > 0;

  return (
    <div className="cc-page ov">
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">Overview</h1>
          <p className="cc-page-sub">
            Everything happening across your WhatsApp numbers right now — volume, workload and the state of the queue.
          </p>
        </div>
        <div className="cc-row">
          <div className="cc-range" role="group" aria-label="Time range">
            {(['today', '7d', '30d'] as const).map(option => (
              <button
                key={option}
                type="button"
                className={`cc-range-btn ${range === option ? 'is-active' : ''}`}
                onClick={() => setRange(option)}
              >
                {option === 'today' ? 'Today' : option === '7d' ? '7 days' : '30 days'}
              </button>
            ))}
          </div>
          <Link to="/inbox" className="cc-btn cc-btn-primary">
            Open inbox <ArrowRight size={14} />
          </Link>
        </div>
      </header>

      {analyticsQuery.error ? (
        <ErrorState error={analyticsQuery.error} onRetry={() => void analyticsQuery.refetch()} />
      ) : null}

      {/* First-run helper: history exists in the gateway but no conversations have been indexed. */}
      {!analyticsQuery.isLoading && !hasAnyData && (
        <div className="ov-firstrun cc-card">
          <div className="cc-card-body">
            <div className="cc-row" style={{ gap: '0.6rem', marginBottom: '0.5rem' }}>
              <Database size={18} />
              <h2 className="cc-card-title">No conversations indexed yet</h2>
            </div>
            <p className="cc-page-sub" style={{ margin: '0 0 0.9rem' }}>
              Conversations appear here automatically as messages arrive. If this gateway already has message history,
              build the inbox from it now — it is safe to run more than once and never overwrites anything you have set.
            </p>
            <button
              type="button"
              className="cc-btn cc-btn-primary"
              disabled={backfill.isPending}
              onClick={() =>
                backfill.mutate(undefined, {
                  onSuccess: result =>
                    success(
                      `Indexed ${result.created} conversations`,
                      `${result.updated} updated · ${result.contacts} contacts added`,
                    ),
                  onError: error =>
                    showError(error instanceof Error ? error.message : 'Could not build the conversation index'),
                })
              }
            >
              {backfill.isPending ? <Loader2 size={14} className="cc-spin" /> : <Database size={14} />}
              Build inbox from history
            </button>
          </div>
        </div>
      )}

      {/* ── KPI grid ─────────────────────────────────────────────── */}
      <section className="cc-kpis">
        {analyticsQuery.isLoading && !kpis
          ? Array.from({ length: 10 }, (_, index) => <Skeleton key={index} height={82} radius="var(--cc-radius-lg)" />)
          : kpis && (
              <>
                <KpiCard
                  label="Connected numbers"
                  value={`${kpis.connectedNumbers}/${kpis.totalNumbers}`}
                  hint={kpis.connectedNumbers < kpis.totalNumbers ? 'Some numbers are offline' : 'All numbers online'}
                  icon={<Smartphone size={14} />}
                />
                <KpiCard
                  label="Messages"
                  value={formatCount(kpis.messages)}
                  hint="In the selected window"
                  icon={<MessageSquare size={14} />}
                />
                <KpiCard label="Incoming" value={formatCount(kpis.inbound)} icon={<ArrowRight size={14} />} />
                <KpiCard label="Outgoing" value={formatCount(kpis.outbound)} icon={<ArrowRight size={14} />} />
                <KpiCard
                  label="New conversations"
                  value={formatCount(kpis.newConversations)}
                  icon={<InboxIcon size={14} />}
                />
                <KpiCard label="Unread" value={formatCount(kpis.unread)} tone={kpis.unread > 0 ? 'open' : 'default'} />
                <KpiCard label="Waiting" value={formatCount(kpis.waiting)} tone="waiting" icon={<Clock size={14} />} />
                <KpiCard
                  label="Resolved"
                  value={formatCount(kpis.resolved)}
                  tone="resolved"
                  icon={<CheckCircle2 size={14} />}
                />
                <KpiCard
                  label="Avg first response"
                  value={formatMinutes(kpis.avgFirstResponseMinutes) ?? '—'}
                  hint={
                    kpis.firstResponseSample === 0
                      ? 'No conversation answered in this window yet'
                      : `From ${kpis.firstResponseSample} conversation${kpis.firstResponseSample === 1 ? '' : 's'}`
                  }
                  icon={<TrendingUp size={14} />}
                />
                <KpiCard
                  label="Avg resolution"
                  value={formatMinutes(kpis.avgResolutionMinutes) ?? '—'}
                  hint={
                    kpis.resolutionSample === 0
                      ? 'Nothing resolved in this window yet'
                      : `From ${kpis.resolutionSample} conversation${kpis.resolutionSample === 1 ? '' : 's'}`
                  }
                  icon={<CheckCircle2 size={14} />}
                />
              </>
            )}
      </section>

      {/* ── Charts ───────────────────────────────────────────────── */}
      <section className="ov-charts">
        <div className="cc-card ov-chart-main">
          <div className="cc-card-head">
            <h2 className="cc-card-title">Messages over time</h2>
            <span className="ov-legend">
              <i style={{ background: '#25d366' }} /> Incoming
              <i style={{ background: '#2563eb', marginLeft: '0.6rem' }} /> Outgoing
            </span>
          </div>
          <div className="cc-card-body" style={{ height: 260 }}>
            {analyticsQuery.isLoading && !data ? (
              <Skeleton height="100%" />
            ) : series.every(point => point.inbound === 0 && point.outbound === 0) ? (
              <EmptyState icon={<MessageSquare size={18} />} title="No messages in this window" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <defs>
                    <linearGradient id="inGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#25d366" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#25d366" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="outGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#2563eb" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#2563eb" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--cc-border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 11, fill: 'var(--cc-text-faint)' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: 'var(--cc-text-faint)' }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--cc-surface-raised)',
                      border: '1px solid var(--cc-border-strong)',
                      borderRadius: 'var(--cc-radius-sm)',
                      fontSize: '0.75rem',
                      color: 'var(--cc-text)',
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="inbound"
                    name="Incoming"
                    stroke="#25d366"
                    fill="url(#inGrad)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="outbound"
                    name="Outgoing"
                    stroke="#2563eb"
                    fill="url(#outGrad)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">Conversations by status</h2>
          </div>
          <div className="cc-card-body" style={{ height: 260 }}>
            {statusData.length === 0 ? (
              <EmptyState icon={<InboxIcon size={18} />} title="No conversations yet" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusData}
                    dataKey="count"
                    nameKey="status"
                    innerRadius={52}
                    outerRadius={82}
                    paddingAngle={3}
                  >
                    {statusData.map(entry => (
                      <Cell key={entry.status} fill={STATUS_COLORS[entry.status] ?? '#94a3b8'} />
                    ))}
                  </Pie>
                  <Legend
                    verticalAlign="bottom"
                    height={30}
                    formatter={value => (
                      <span style={{ fontSize: '0.75rem', color: 'var(--cc-text-secondary)' }}>{value}</span>
                    )}
                  />
                  <Tooltip
                    contentStyle={{
                      background: 'var(--cc-surface-raised)',
                      border: '1px solid var(--cc-border-strong)',
                      borderRadius: 'var(--cc-radius-sm)',
                      fontSize: '0.75rem',
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">Busiest hours</h2>
            {data?.peakHour !== null && data?.peakHour !== undefined && (
              <span className="cc-chip cc-chip-neutral">Peak {formatHour(data.peakHour)}</span>
            )}
          </div>
          <div className="cc-card-body" style={{ height: 200 }}>
            {hours.every(hour => hour.count === 0) ? (
              <EmptyState icon={<Clock size={18} />} title="No traffic yet" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hours} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--cc-border)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 10, fill: 'var(--cc-text-faint)' }}
                    interval={3}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: 'var(--cc-text-faint)' }}
                    tickLine={false}
                    axisLine={false}
                    allowDecimals={false}
                  />
                  <Tooltip
                    cursor={{ fill: 'var(--cc-surface-hover)' }}
                    contentStyle={{
                      background: 'var(--cc-surface-raised)',
                      border: '1px solid var(--cc-border-strong)',
                      borderRadius: 'var(--cc-radius-sm)',
                      fontSize: '0.75rem',
                    }}
                  />
                  <Bar dataKey="count" name="Messages" fill="#7c3aed" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        <div className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">Team workload</h2>
          </div>
          <div className="cc-card-body">
            {(data?.agentWorkload ?? []).length === 0 ? (
              <EmptyState
                icon={<Users size={18} />}
                title="Nothing assigned yet"
                description="Assign conversations from the inbox to see workload here."
              />
            ) : (
              <ul className="ov-workload">
                {(() => {
                  // Each bar is the agent's open count relative to the BUSIEST agent, not to their
                  // own resolved count. The latter is what this card used to draw, and it put every
                  // agent with nothing resolved yet at 100% — so someone holding one conversation
                  // looked exactly as loaded as someone holding twelve, which is the opposite of
                  // what a card called "Team workload" is for.
                  const rows = (data?.agentWorkload ?? []).slice(0, 6);
                  const busiest = Math.max(1, ...rows.map(row => row.open));
                  return rows.map(entry => {
                    const openShare = Math.round((entry.open / busiest) * 100);
                    return (
                      <li key={entry.agentId ?? 'unassigned'}>
                        <span className="ov-workload-name cc-truncate">
                          <i style={{ background: entry.color }} />
                          {entry.name}
                        </span>
                        <span className="ov-workload-bar">
                          <span style={{ width: `${openShare}%`, background: entry.color }} />
                        </span>
                        <span className="ov-workload-num cc-num">
                          {entry.open} open · {entry.resolved} done
                        </span>
                      </li>
                    );
                  });
                })()}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ── Numbers + recent activity ────────────────────────────── */}
      <section className="ov-bottom">
        <div className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">WhatsApp numbers</h2>
            <Link to="/numbers" className="cc-btn cc-btn-ghost cc-btn-sm">
              Manage <ArrowRight size={12} />
            </Link>
          </div>
          <div className="cc-card-body" style={{ padding: 0 }}>
            {sessionsQuery.isLoading ? (
              <div style={{ padding: '1rem' }}>
                <Skeleton height={44} />
              </div>
            ) : sessions.length === 0 ? (
              <EmptyState
                icon={<Smartphone size={18} />}
                title="No numbers connected"
                description="Connect a WhatsApp number to start receiving conversations."
                action={
                  <Link to="/numbers" className="cc-btn cc-btn-primary cc-btn-sm">
                    Connect a number
                  </Link>
                }
              />
            ) : (
              <ul className="ov-sessions">
                {sessions.map(session => {
                  const stats = data?.topSessions.find(item => item.sessionId === session.id);
                  return (
                    <li key={session.id}>
                      <HealthDot status={session.status} />
                      <span className="ov-session-name cc-truncate">{session.name}</span>
                      <span className="ov-session-status">{session.status.replace(/_/g, ' ')}</span>
                      <span className="ov-session-num cc-num">
                        {stats ? `${formatCount(stats.inbound + stats.outbound)} msgs` : '—'}
                      </span>
                      {session.restriction && (
                        <span className="cc-chip cc-chip-urgent" title={session.restriction.code}>
                          <AlertTriangle size={10} /> restricted
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>

        <div className="cc-card">
          <div className="cc-card-head">
            <h2 className="cc-card-title">Recent activity</h2>
            <Link to="/inbox" className="cc-btn cc-btn-ghost cc-btn-sm">
              Open inbox <ArrowRight size={12} />
            </Link>
          </div>
          <div className="cc-card-body" style={{ padding: 0 }}>
            {recentQuery.isLoading ? (
              <div style={{ padding: '1rem' }}>
                <Skeleton height={44} />
              </div>
            ) : (recentQuery.data?.conversations ?? []).length === 0 ? (
              <EmptyState icon={<Activity size={18} />} title="No recent conversations" />
            ) : (
              <ul className="ov-activity">
                {(recentQuery.data?.conversations ?? []).map(conversation => (
                  <li key={conversation.id}>
                    <Avatar name={conversation.chatName} seed={conversation.chatId} size="sm" />
                    <span className="ov-activity-name cc-truncate">
                      {conversation.chatName || formatWaId(conversation.chatId)}
                    </span>
                    <span className="ov-activity-preview cc-truncate">{conversation.lastMessagePreview}</span>
                    <span className={`cc-status-pill is-${conversation.status}`}>{conversation.status}</span>
                    <time className="ov-activity-time cc-num" dateTime={conversation.lastMessageAt ?? undefined}>
                      {relativeTime(conversation.lastMessageAt)}
                    </time>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

export default Overview;
