import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { AgentEvent } from './entities/agent-event.entity';

/**
 * The queue between a schedule and the agent (brief §11).
 *
 * A cron job's entire job is `raise()`. It does not send, does not decide and does not talk
 * to WhatsApp — because a scheduler that can send is a second route to a customer that
 * bypasses the permission layer, the quiet hours and the daily caps.
 *
 * Rows survive restarts, which is the other half of §11: work queued at 09:00 is still
 * there at 09:05 after a deploy.
 */
@Injectable()
export class AgentEventService {
  private readonly logger = createLogger('AgentEventService');

  constructor(@InjectRepository(AgentEvent, 'data') private readonly events: Repository<AgentEvent>) {}

  /**
   * Records an event, exactly once.
   *
   * Deduplication is the unique index on `eventKey`, not a check-then-insert: overlapping
   * cron runs, a retry after a crash and two workers racing all converge on one row, because
   * the loser gets a constraint violation instead of creating a second reminder.
   */
  async raise(input: {
    eventType: string;
    eventKey: string;
    subjectPhone?: string | null;
    subjectContactId?: string | null;
    payload?: Record<string, unknown>;
    runAfter?: Date;
  }): Promise<{ created: boolean; id: string | null }> {
    try {
      const saved = await this.events.save(
        this.events.create({
          eventType: input.eventType,
          eventKey: input.eventKey,
          subjectPhone: input.subjectPhone ?? null,
          subjectContactId: input.subjectContactId ?? null,
          payload: input.payload ?? null,
          runAfter: input.runAfter ?? new Date(),
          state: 'pending',
          createdAt: new Date(),
        }),
      );
      return { created: true, id: saved.id };
    } catch (error) {
      // A duplicate key is the mechanism working, not a failure worth surfacing.
      if (isUniqueViolation(error)) return { created: false, id: null };
      throw error;
    }
  }

  /** Events due now. Claimed one at a time so a crash mid-batch loses at most one. */
  async claimDue(limit = 20): Promise<AgentEvent[]> {
    const due = await this.events.find({
      where: { state: 'pending', runAfter: LessThanOrEqual(new Date()) },
      order: { runAfter: 'ASC' },
      take: limit,
    });

    const claimed: AgentEvent[] = [];
    for (const event of due) {
      // Conditional update: whoever flips it from pending owns it. A second worker that
      // read the same row gets `affected === 0` and moves on.
      const result = await this.events.update({ id: event.id, state: 'pending' }, { state: 'processing' });
      if (result.affected) claimed.push(event);
    }
    return claimed;
  }

  async complete(id: string, turnId: string | null, detail?: string): Promise<void> {
    await this.events.update({ id }, { state: 'done', turnId, outcomeDetail: detail?.slice(0, 300) ?? null });
  }

  /** A skip must always say why — a silently dropped event is the worst bug in a scheduler. */
  async skip(id: string, reason: string): Promise<void> {
    await this.events.update({ id }, { state: 'skipped', outcomeDetail: reason.slice(0, 300) });
  }

  async fail(id: string, reason: string): Promise<void> {
    const event = await this.events.findOne({ where: { id } });
    const attempts = (event?.attempts ?? 0) + 1;
    await this.events.update(
      { id },
      {
        // Three attempts, then it stops and waits for a person. An event retrying forever
        // is indistinguishable from one that is working.
        state: attempts >= 3 ? 'failed' : 'pending',
        attempts,
        outcomeDetail: reason.slice(0, 300),
        runAfter: new Date(Date.now() + attempts * 5 * 60_000),
      },
    );
  }

  async listRecent(limit = 100): Promise<AgentEvent[]> {
    return this.events.find({ order: { createdAt: 'DESC' }, take: limit });
  }
}

function isUniqueViolation(error: unknown): boolean {
  const code =
    (error as { code?: string; driverError?: { code?: string } })?.code ??
    (error as { driverError?: { code?: string } })?.driverError?.code;
  // 23505 is Postgres; SQLITE_CONSTRAINT covers the zero-dependency install.
  return code === '23505' || String(code ?? '').startsWith('SQLITE_CONSTRAINT');
}
