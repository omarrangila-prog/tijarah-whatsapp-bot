import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Message, MessageDirection, MessageStatus } from '../message/entities/message.entity';
import { Conversation, ConversationStatus } from './entities/conversation.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { Agent } from './entities/agent.entity';
import { minutesBetween } from './conversation-state';

export type AnalyticsRange = 'today' | '7d' | '30d' | 'custom';

export interface AnalyticsQuery {
  range?: AnalyticsRange;
  /** ISO timestamps, required when `range` is `custom`. */
  from?: string;
  to?: string;
  sessionIds?: string[];
}

export interface AnalyticsResult {
  window: { from: string; to: string; granularity: 'hour' | 'day' };
  kpis: {
    connectedNumbers: number;
    totalNumbers: number;
    messages: number;
    inbound: number;
    outbound: number;
    failed: number;
    newConversations: number;
    unread: number;
    open: number;
    waiting: number;
    resolved: number;
    newContacts: number;
    /** Minutes. Null when no conversation in the window has both marks. */
    avgFirstResponseMinutes: number | null;
    avgResolutionMinutes: number | null;
    /** How many conversations each average is computed from — an average of 2 is not a trend. */
    firstResponseSample: number;
    resolutionSample: number;
  };
  timeSeries: Array<{ bucket: string; inbound: number; outbound: number }>;
  byStatus: Array<{ status: string; count: number }>;
  busiestHours: Array<{ hour: number; count: number }>;
  topSessions: Array<{ sessionId: string; name: string | null; inbound: number; outbound: number }>;
  agentWorkload: Array<{ agentId: string | null; name: string; open: number; resolved: number; color: string }>;
  peakHour: number | null;
}

/**
 * Analytics computed from data the gateway actually holds.
 *
 * Nothing here is estimated or padded. Where a metric needs a timestamp that only exists because
 * `cc_conversations` records it (first response, resolution), the number is computed from that
 * column and reported with its sample size; where no data supports a metric, the field is null and
 * the UI says so rather than drawing a zero.
 *
 * Bucketing is done in SQL with a per-dialect expression rather than by pulling rows into JS: the
 * message table is the hot one, and streaming a month of rows to count them would be the single
 * most expensive thing the dashboard does.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    @InjectRepository(Message, 'data') private readonly messages: Repository<Message>,
    @InjectRepository(Conversation, 'data') private readonly conversations: Repository<Conversation>,
    @InjectRepository(CustomerProfile, 'data') private readonly profiles: Repository<CustomerProfile>,
    @InjectRepository(Agent, 'data') private readonly agents: Repository<Agent>,
    // Named explicitly: this project runs two connections, and the bucket expression below must be
    // built for the DATA connection's dialect, not whichever DataSource DI would default to.
    @InjectDataSource('data') private readonly dataSource: DataSource,
  ) {}

  private get isPostgres(): boolean {
    return this.dataSource.options.type === 'postgres';
  }

  async compute(
    query: AnalyticsQuery,
    sessions: Array<{ id: string; name: string; status: string }>,
  ): Promise<AnalyticsResult> {
    const { from, to, granularity } = resolveWindow(query);
    const sessionIds = query.sessionIds?.length ? query.sessionIds : sessions.map(s => s.id);
    const sessionNames = new Map(sessions.map(s => [s.id, s.name]));

    // An empty session list means there is nothing to report on. Returning early avoids emitting
    // `IN ()`, which is a syntax error on both dialects.
    if (sessionIds.length === 0) {
      return emptyResult(from, to, granularity, sessions.length);
    }

    const [directionCounts, failedCount, buckets, hours, perSession, conversationStats, workload, newContacts] =
      await Promise.all([
        this.countByDirection(sessionIds, from, to),
        this.countFailed(sessionIds, from, to),
        this.bucketSeries(sessionIds, from, to, granularity),
        this.hourHistogram(sessionIds, from, to),
        this.perSessionCounts(sessionIds, from, to),
        this.conversationStats(sessionIds, from, to),
        this.agentWorkload(sessionIds),
        this.countNewContacts(from, to),
      ]);

    const inbound = directionCounts.get(MessageDirection.INCOMING) ?? 0;
    const outbound = directionCounts.get(MessageDirection.OUTGOING) ?? 0;
    const peak = hours.reduce<{ hour: number; count: number } | null>(
      (best, row) => (best === null || row.count > best.count ? row : best),
      null,
    );

    return {
      window: { from: from.toISOString(), to: to.toISOString(), granularity },
      kpis: {
        connectedNumbers: sessions.filter(s => s.status === 'ready').length,
        totalNumbers: sessions.length,
        messages: inbound + outbound,
        inbound,
        outbound,
        failed: failedCount,
        newConversations: conversationStats.created,
        unread: conversationStats.unread,
        open: conversationStats.open,
        waiting: conversationStats.waiting,
        resolved: conversationStats.resolved,
        newContacts,
        avgFirstResponseMinutes: conversationStats.avgFirstResponseMinutes,
        avgResolutionMinutes: conversationStats.avgResolutionMinutes,
        firstResponseSample: conversationStats.firstResponseSample,
        resolutionSample: conversationStats.resolutionSample,
      },
      timeSeries: buckets,
      byStatus: [
        { status: 'open', count: conversationStats.open },
        { status: 'waiting', count: conversationStats.waiting },
        { status: 'resolved', count: conversationStats.resolved },
      ],
      busiestHours: hours,
      topSessions: perSession
        .map(row => ({ ...row, name: sessionNames.get(row.sessionId) ?? null }))
        .sort((a, b) => b.inbound + b.outbound - (a.inbound + a.outbound))
        .slice(0, 8),
      agentWorkload: workload,
      peakHour: peak && peak.count > 0 ? peak.hour : null,
    };
  }

  // --------------------------------------------------------------- queries

  private async countByDirection(sessionIds: string[], from: Date, to: Date): Promise<Map<string, number>> {
    const rows = await this.messages
      .createQueryBuilder('m')
      .select('m.direction', 'direction')
      .addSelect('COUNT(*)', 'total')
      .where('m.sessionId IN (:...sessionIds)', { sessionIds })
      .andWhere('m.createdAt >= :from AND m.createdAt < :to', { from, to })
      .groupBy('m.direction')
      .getRawMany<{ direction: MessageDirection; total: string | number }>();
    return new Map(rows.map(row => [row.direction, Number(row.total)]));
  }

  private async countFailed(sessionIds: string[], from: Date, to: Date): Promise<number> {
    return this.messages
      .createQueryBuilder('m')
      .where('m.sessionId IN (:...sessionIds)', { sessionIds })
      .andWhere('m.createdAt >= :from AND m.createdAt < :to', { from, to })
      .andWhere('m.status = :status', { status: MessageStatus.FAILED })
      .getCount();
  }

  /**
   * Message volume per bucket.
   *
   * The bucket key is produced by the database so the range scan stays on the `createdAt` index.
   * Postgres and SQLite need different expressions for that, which is the only dialect branch in
   * this file.
   */
  private async bucketSeries(
    sessionIds: string[],
    from: Date,
    to: Date,
    granularity: 'hour' | 'day',
  ): Promise<Array<{ bucket: string; inbound: number; outbound: number }>> {
    const expression = this.isPostgres
      ? `to_char(date_trunc('${granularity}', m."createdAt"), '${granularity === 'hour' ? 'YYYY-MM-DD HH24:00' : 'YYYY-MM-DD'}')`
      : `strftime('${granularity === 'hour' ? '%Y-%m-%d %H:00' : '%Y-%m-%d'}', m."createdAt")`;

    const rows = await this.messages
      .createQueryBuilder('m')
      .select(expression, 'bucket')
      .addSelect('m.direction', 'direction')
      .addSelect('COUNT(*)', 'total')
      .where('m.sessionId IN (:...sessionIds)', { sessionIds })
      .andWhere('m.createdAt >= :from AND m.createdAt < :to', { from, to })
      .groupBy('bucket')
      .addGroupBy('m.direction')
      .orderBy('bucket', 'ASC')
      .getRawMany<{ bucket: string; direction: MessageDirection; total: string | number }>();

    // Every bucket in the window is emitted, including empty ones — a chart that silently skips
    // quiet hours misrepresents the shape of the day.
    const series = new Map(
      enumerateBuckets(from, to, granularity).map(bucket => [bucket, { bucket, inbound: 0, outbound: 0 }]),
    );
    for (const row of rows) {
      const entry = series.get(row.bucket);
      if (!entry) continue;
      if (row.direction === MessageDirection.INCOMING) entry.inbound += Number(row.total);
      else entry.outbound += Number(row.total);
    }
    return [...series.values()];
  }

  private async hourHistogram(
    sessionIds: string[],
    from: Date,
    to: Date,
  ): Promise<Array<{ hour: number; count: number }>> {
    const expression = this.isPostgres
      ? `EXTRACT(HOUR FROM m."createdAt")`
      : `CAST(strftime('%H', m."createdAt") AS INTEGER)`;
    const rows = await this.messages
      .createQueryBuilder('m')
      .select(expression, 'hour')
      .addSelect('COUNT(*)', 'total')
      .where('m.sessionId IN (:...sessionIds)', { sessionIds })
      .andWhere('m.createdAt >= :from AND m.createdAt < :to', { from, to })
      .groupBy('hour')
      .getRawMany<{ hour: string | number; total: string | number }>();

    const histogram = Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 }));
    for (const row of rows) {
      const hour = Number(row.hour);
      if (Number.isInteger(hour) && hour >= 0 && hour < 24) histogram[hour].count = Number(row.total);
    }
    return histogram;
  }

  private async perSessionCounts(
    sessionIds: string[],
    from: Date,
    to: Date,
  ): Promise<Array<{ sessionId: string; inbound: number; outbound: number }>> {
    const rows = await this.messages
      .createQueryBuilder('m')
      .select('m.sessionId', 'sessionId')
      .addSelect('m.direction', 'direction')
      .addSelect('COUNT(*)', 'total')
      .where('m.sessionId IN (:...sessionIds)', { sessionIds })
      .andWhere('m.createdAt >= :from AND m.createdAt < :to', { from, to })
      .groupBy('m.sessionId')
      .addGroupBy('m.direction')
      .getRawMany<{ sessionId: string; direction: MessageDirection; total: string | number }>();

    const bySession = new Map<string, { sessionId: string; inbound: number; outbound: number }>();
    for (const row of rows) {
      const entry = bySession.get(row.sessionId) ?? { sessionId: row.sessionId, inbound: 0, outbound: 0 };
      if (row.direction === MessageDirection.INCOMING) entry.inbound += Number(row.total);
      else entry.outbound += Number(row.total);
      bySession.set(row.sessionId, entry);
    }
    return [...bySession.values()];
  }

  /**
   * Conversation counts and the duration averages.
   *
   * Status counts are current state (an inbox shows what is open NOW, not what was open last
   * Tuesday); `created` and the duration averages are windowed. The averages load only the two
   * timestamp columns for conversations that actually have both marks, so the row count is bounded
   * by resolved/answered conversations rather than by total traffic.
   */
  private async conversationStats(
    sessionIds: string[],
    from: Date,
    to: Date,
  ): Promise<{
    created: number;
    unread: number;
    open: number;
    waiting: number;
    resolved: number;
    avgFirstResponseMinutes: number | null;
    avgResolutionMinutes: number | null;
    firstResponseSample: number;
    resolutionSample: number;
  }> {
    const base = () =>
      this.conversations.createQueryBuilder('c').where('c.sessionId IN (:...sessionIds)', { sessionIds });

    const [created, unread, statusRows, responded, resolvedRows] = await Promise.all([
      base().andWhere('c.createdAt >= :from AND c.createdAt < :to', { from, to }).getCount(),
      base().andWhere('(c.unreadCount > 0 OR c.manualUnread = :yes)', { yes: true }).getCount(),
      base()
        .select('c.status', 'status')
        .addSelect('COUNT(*)', 'total')
        .groupBy('c.status')
        .getRawMany<{ status: ConversationStatus; total: string | number }>(),
      base()
        .select(['c.id', 'c.firstInboundAt', 'c.firstResponseAt'])
        .andWhere('c.firstResponseAt IS NOT NULL')
        .andWhere('c.firstInboundAt IS NOT NULL')
        .andWhere('c.firstResponseAt >= :from AND c.firstResponseAt < :to', { from, to })
        .getMany(),
      base()
        .select(['c.id', 'c.firstInboundAt', 'c.resolvedAt'])
        .andWhere('c.resolvedAt IS NOT NULL')
        .andWhere('c.firstInboundAt IS NOT NULL')
        .andWhere('c.resolvedAt >= :from AND c.resolvedAt < :to', { from, to })
        .getMany(),
    ]);

    const statusCounts = new Map(statusRows.map(row => [row.status, Number(row.total)]));
    const responseDurations = responded
      .map(row => minutesBetween(row.firstInboundAt, row.firstResponseAt))
      .filter((value): value is number => value !== null);
    const resolutionDurations = resolvedRows
      .map(row => minutesBetween(row.firstInboundAt, row.resolvedAt))
      .filter((value): value is number => value !== null);

    return {
      created,
      unread,
      open: statusCounts.get(ConversationStatus.OPEN) ?? 0,
      waiting: statusCounts.get(ConversationStatus.WAITING) ?? 0,
      resolved: statusCounts.get(ConversationStatus.RESOLVED) ?? 0,
      avgFirstResponseMinutes: average(responseDurations),
      avgResolutionMinutes: average(resolutionDurations),
      firstResponseSample: responseDurations.length,
      resolutionSample: resolutionDurations.length,
    };
  }

  /** Current load per agent — open vs resolved, so a busy queue is visible before it becomes a backlog. */
  private async agentWorkload(
    sessionIds: string[],
  ): Promise<Array<{ agentId: string | null; name: string; open: number; resolved: number; color: string }>> {
    const rows = await this.conversations
      .createQueryBuilder('c')
      .select('c.assigneeId', 'assigneeId')
      .addSelect('c.status', 'status')
      .addSelect('COUNT(*)', 'total')
      .where('c.sessionId IN (:...sessionIds)', { sessionIds })
      .groupBy('c.assigneeId')
      .addGroupBy('c.status')
      .getRawMany<{ assigneeId: string | null; status: ConversationStatus; total: string | number }>();

    const agents = await this.agents.find();
    const agentById = new Map(agents.map(a => [a.id, a]));
    const byAgent = new Map<
      string,
      { agentId: string | null; name: string; open: number; resolved: number; color: string }
    >();

    for (const row of rows) {
      const key = row.assigneeId ?? '__unassigned__';
      const agent = row.assigneeId ? agentById.get(row.assigneeId) : undefined;
      const entry = byAgent.get(key) ?? {
        agentId: row.assigneeId,
        name: row.assigneeId ? (agent?.name ?? 'Removed agent') : 'Unassigned',
        open: 0,
        resolved: 0,
        color: agent?.color ?? '#94a3b8',
      };
      if (row.status === ConversationStatus.RESOLVED) entry.resolved += Number(row.total);
      else entry.open += Number(row.total);
      byAgent.set(key, entry);
    }
    return [...byAgent.values()].sort((a, b) => b.open - a.open);
  }

  private countNewContacts(from: Date, to: Date): Promise<number> {
    return this.profiles
      .createQueryBuilder('p')
      .where('p.firstInteractionAt >= :from AND p.firstInteractionAt < :to', { from, to })
      .getCount();
  }
}

/** Resolve the requested range into concrete bounds plus the bucket size that suits it. */
export function resolveWindow(query: AnalyticsQuery): { from: Date; to: Date; granularity: 'hour' | 'day' } {
  const now = new Date();
  if (query.range === 'custom' && query.from) {
    const from = new Date(query.from);
    const to = query.to ? new Date(query.to) : now;
    const valid = !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from < to;
    if (valid) {
      const spanHours = (to.getTime() - from.getTime()) / 3_600_000;
      return { from, to, granularity: spanHours <= 48 ? 'hour' : 'day' };
    }
  }
  if (query.range === 'today') {
    const from = new Date(now);
    from.setHours(0, 0, 0, 0);
    return { from, to: now, granularity: 'hour' };
  }
  const days = query.range === '30d' ? 30 : 7;
  const from = new Date(now.getTime() - days * 86_400_000);
  return { from, to: now, granularity: 'day' };
}

/** Every bucket label in the window, so empty periods are drawn rather than skipped. */
export function enumerateBuckets(from: Date, to: Date, granularity: 'hour' | 'day'): string[] {
  const labels: string[] = [];
  const cursor = new Date(from);
  if (granularity === 'hour') cursor.setMinutes(0, 0, 0);
  else cursor.setHours(0, 0, 0, 0);

  // Bounded so a wildly wide custom range cannot generate an unbounded array.
  const limit = granularity === 'hour' ? 24 * 14 : 400;
  while (cursor < to && labels.length < limit) {
    labels.push(formatBucket(cursor, granularity));
    if (granularity === 'hour') cursor.setHours(cursor.getHours() + 1);
    else cursor.setDate(cursor.getDate() + 1);
  }
  return labels;
}

function formatBucket(date: Date, granularity: 'hour' | 'day'): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return granularity === 'hour' ? `${day} ${pad(date.getHours())}:00` : day;
}

/** Mean, rounded to one decimal. Null for an empty sample — never 0, which would read as "instant". */
export function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function emptyResult(from: Date, to: Date, granularity: 'hour' | 'day', totalNumbers: number): AnalyticsResult {
  return {
    window: { from: from.toISOString(), to: to.toISOString(), granularity },
    kpis: {
      connectedNumbers: 0,
      totalNumbers,
      messages: 0,
      inbound: 0,
      outbound: 0,
      failed: 0,
      newConversations: 0,
      unread: 0,
      open: 0,
      waiting: 0,
      resolved: 0,
      newContacts: 0,
      avgFirstResponseMinutes: null,
      avgResolutionMinutes: null,
      firstResponseSample: 0,
      resolutionSample: 0,
    },
    timeSeries: enumerateBuckets(from, to, granularity).map(bucket => ({ bucket, inbound: 0, outbound: 0 })),
    byStatus: [
      { status: 'open', count: 0 },
      { status: 'waiting', count: 0 },
      { status: 'resolved', count: 0 },
    ],
    busiestHours: Array.from({ length: 24 }, (_, hour) => ({ hour, count: 0 })),
    topSessions: [],
    agentWorkload: [],
    peakHour: null,
  };
}
