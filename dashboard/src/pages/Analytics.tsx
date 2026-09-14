import { useMemo, useState } from 'react';
import { BarChart3, Clock, Download, TrendingUp, Users } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { useAnalyticsQuery } from '../hooks/commandCenter';
import { useSessionsQuery } from '../hooks/queries';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { EmptyState, ErrorState, KpiCard, Skeleton } from '../components/cc/Primitives';
import { downloadCsv, toCsv } from '../utils/csv';
import { formatBucketLabel, formatCount, formatHour, formatMinutes } from '../utils/ccFormat';
import type { AnalyticsRange } from '../services/commandCenter';
import './Analytics.css';

const TOOLTIP_STYLE = {
  background: 'var(--cc-surface-raised)',
  border: '1px solid var(--cc-border-strong)',
  borderRadius: 'var(--cc-radius-sm)',
  fontSize: '0.75rem',
  color: 'var(--cc-text)',
};

/**
 * Analytics.
 *
 * Same data source as Overview, with the range controls and per-number filtering an analyst wants
 * plus a CSV export. Duration metrics always carry their sample size, because an average taken from
 * three conversations is a fact about three conversations, not a trend.
 */
export function Analytics() {
  useDocumentTitle('Analytics');

  const [range, setRange] = useState<AnalyticsRange>('7d');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sessionIds, setSessionIds] = useState<string[]>([]);

  const sessionsQuery = useSessionsQuery();
  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);

  const params = useMemo(
    () => ({
      range,
      ...(range === 'custom' && from ? { from: new Date(from).toISOString() } : {}),
      ...(range === 'custom' && to ? { to: new Date(to).toISOString() } : {}),
      ...(sessionIds.length ? { sessionIds } : {}),
    }),
    [range, from, to, sessionIds],
  );

  const analyticsQuery = useAnalyticsQuery(params);
  const data = analyticsQuery.data;
  const kpis = data?.kpis;

  const series = useMemo(
    () => (data?.timeSeries ?? []).map(point => ({ ...point, label: formatBucketLabel(point.bucket), total: point.inbound + point.outbound })),
    [data?.timeSeries],
  );
  const hours = useMemo(() => (data?.busiestHours ?? []).map(hour => ({ ...hour, label: formatHour(hour.hour) })), [data?.busiestHours]);

  const exportCsv = () => {
    if (!data) return;
    const rows = data.timeSeries.map(point => ({
      bucket: point.bucket,
      incoming: point.inbound,
      outgoing: point.outbound,
      total: point.inbound + point.outbound,
    }));
    downloadCsv(`wa-analytics-${range}.csv`, toCsv(rows, ['bucket', 'incoming', 'outgoing', 'total']));
  };

  const empty = !analyticsQuery.isLoading && (kpis?.messages ?? 0) === 0;

  return (
    <div className="cc-page an">
      <header className="cc-page-head">
        <div>
          <h1 className="cc-page-title">Analytics</h1>
          <p className="cc-page-sub">
            Volume, responsiveness and workload across the window you choose. Every figure is computed from stored
            messages and conversation timestamps.
          </p>
        </div>
        <div className="cc-row">
          <div className="cc-range" role="group" aria-label="Time range">
            {(['today', '7d', '30d', 'custom'] as const).map(option => (
              <button key={option} type="button" className={`cc-range-btn ${range === option ? 'is-active' : ''}`} onClick={() => setRange(option)}>
                {option === 'today' ? 'Today' : option === '7d' ? '7 days' : option === '30d' ? '30 days' : 'Custom'}
              </button>
            ))}
          </div>
          <button type="button" className="cc-btn" onClick={exportCsv} disabled={!data}>
            <Download size={14} /> Export CSV
          </button>
        </div>
      </header>

      <div className="an-filters cc-card">
        <div className="cc-card-body an-filters-body">
          {range === 'custom' && (
            <div className="cc-row" style={{ gap: '0.4rem' }}>
              <label className="an-date">
                <span>From</span>
                <input className="cc-input" type="date" value={from} onChange={event => setFrom(event.target.value)} />
              </label>
              <label className="an-date">
                <span>To</span>
                <input className="cc-input" type="date" value={to} onChange={event => setTo(event.target.value)} />
              </label>
            </div>
          )}
          <div className="an-sessions">
            <span className="cc-label" style={{ margin: 0 }}>
              Numbers
            </span>
            <button type="button" className={`cc-tag-toggle ${sessionIds.length === 0 ? 'is-active' : ''}`} onClick={() => setSessionIds([])}>
              All
            </button>
            {sessions.map(session => (
              <button
                key={session.id}
                type="button"
                className={`cc-tag-toggle ${sessionIds.includes(session.id) ? 'is-active' : ''}`}
                onClick={() =>
                  setSessionIds(current => (current.includes(session.id) ? current.filter(id => id !== session.id) : [...current, session.id]))
                }
              >
                {session.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      {analyticsQuery.error && <ErrorState error={analyticsQuery.error} onRetry={() => void analyticsQuery.refetch()} />}

      <section className="cc-kpis">
        {analyticsQuery.isLoading && !kpis
          ? Array.from({ length: 8 }, (_, index) => <Skeleton key={index} height={82} radius="var(--cc-radius-lg)" />)
          : kpis && (
              <>
                <KpiCard label="Total messages" value={formatCount(kpis.messages)} icon={<BarChart3 size={14} />} />
                <KpiCard label="Incoming" value={formatCount(kpis.inbound)} />
                <KpiCard label="Outgoing" value={formatCount(kpis.outbound)} />
                <KpiCard label="Failed sends" value={formatCount(kpis.failed)} tone={kpis.failed > 0 ? 'urgent' : 'default'} />
                <KpiCard label="New conversations" value={formatCount(kpis.newConversations)} />
                <KpiCard label="New contacts" value={formatCount(kpis.newContacts)} icon={<Users size={14} />} />
                <KpiCard
                  label="Avg first response"
                  value={formatMinutes(kpis.avgFirstResponseMinutes) ?? '—'}
                  hint={kpis.firstResponseSample === 0 ? 'No answered conversations in this window' : `n = ${kpis.firstResponseSample}`}
                  icon={<TrendingUp size={14} />}
                />
                <KpiCard
                  label="Avg resolution"
                  value={formatMinutes(kpis.avgResolutionMinutes) ?? '—'}
                  hint={kpis.resolutionSample === 0 ? 'Nothing resolved in this window' : `n = ${kpis.resolutionSample}`}
                  icon={<Clock size={14} />}
                />
                <KpiCard label="Unresolved now" value={formatCount(kpis.open + kpis.waiting)} tone="open" />
                <KpiCard label="Peak hour" value={data?.peakHour !== null && data?.peakHour !== undefined ? formatHour(data.peakHour) : '—'} hint={data?.peakHour === null ? 'No traffic yet' : 'Busiest hour of the day'} />
              </>
            )}
      </section>

      {empty ? (
        <div className="cc-card">
          <EmptyState
            icon={<BarChart3 size={22} />}
            title="No data in this window"
            description="Try a wider range, or check that at least one WhatsApp number is connected and receiving messages."
          />
        </div>
      ) : (
        <>
          <section className="an-charts">
            <div className="cc-card an-chart-wide">
              <div className="cc-card-head">
                <h2 className="cc-card-title">Message volume</h2>
              </div>
              <div className="cc-card-body" style={{ height: 280 }}>
                {analyticsQuery.isLoading && !data ? (
                  <Skeleton height="100%" />
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={series} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--cc-border)" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--cc-text-faint)' }} tickLine={false} axisLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: 'var(--cc-text-faint)' }} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={TOOLTIP_STYLE} />
                      <Line type="monotone" dataKey="inbound" name="Incoming" stroke="#25d366" strokeWidth={2} dot={false} />
                      <Line type="monotone" dataKey="outbound" name="Outgoing" stroke="#2563eb" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="cc-card">
              <div className="cc-card-head">
                <h2 className="cc-card-title">Volume by hour</h2>
              </div>
              <div className="cc-card-body" style={{ height: 220 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={hours} margin={{ top: 4, right: 8, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--cc-border)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--cc-text-faint)' }} interval={2} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fontSize: 10, fill: 'var(--cc-text-faint)' }} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip cursor={{ fill: 'var(--cc-surface-hover)' }} contentStyle={TOOLTIP_STYLE} />
                    <Bar dataKey="count" name="Messages" fill="#7c3aed" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="cc-card">
              <div className="cc-card-head">
                <h2 className="cc-card-title">Volume by number</h2>
              </div>
              <div className="cc-card-body" style={{ padding: 0 }}>
                {(data?.topSessions ?? []).length === 0 ? (
                  <EmptyState title="No traffic yet" />
                ) : (
                  <div className="cc-table-scroll">
                    <table className="cc-table">
                      <thead>
                        <tr>
                          <th>Number</th>
                          <th className="an-right">In</th>
                          <th className="an-right">Out</th>
                          <th className="an-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data?.topSessions ?? []).map(row => (
                          <tr key={row.sessionId}>
                            <td className="cc-truncate">{row.name ?? row.sessionId}</td>
                            <td className="cc-num an-right">{formatCount(row.inbound)}</td>
                            <td className="cc-num an-right">{formatCount(row.outbound)}</td>
                            <td className="cc-num an-right">
                              <b>{formatCount(row.inbound + row.outbound)}</b>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="cc-card">
              <div className="cc-card-head">
                <h2 className="cc-card-title">Agent workload</h2>
              </div>
              <div className="cc-card-body" style={{ padding: 0 }}>
                {(data?.agentWorkload ?? []).length === 0 ? (
                  <EmptyState title="Nothing assigned yet" description="Assign conversations in the inbox to see workload here." />
                ) : (
                  <div className="cc-table-scroll">
                    <table className="cc-table">
                      <thead>
                        <tr>
                          <th>Agent</th>
                          <th className="an-right">Open</th>
                          <th className="an-right">Resolved</th>
                          <th className="an-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data?.agentWorkload ?? []).map(row => (
                          <tr key={row.agentId ?? 'unassigned'}>
                            <td>
                              <span className="cc-row" style={{ gap: '0.4rem' }}>
                                <i className="an-swatch" style={{ background: row.color }} />
                                {row.name}
                              </span>
                            </td>
                            <td className="cc-num an-right">{formatCount(row.open)}</td>
                            <td className="cc-num an-right">{formatCount(row.resolved)}</td>
                            <td className="cc-num an-right">
                              <b>{formatCount(row.open + row.resolved)}</b>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default Analytics;
