import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { ScheduledMessage, ScheduledMessageStatus } from './entities/scheduled-message.entity';

/** How often the queue is drained. */
const TICK_MS = 30_000;

/** Rows claimed per tick — bounds the work one tick can do on a queue that has backed up. */
const BATCH_SIZE = 20;

/**
 * Send-later queue.
 *
 * Deliberately a simple periodic drain rather than a BullMQ job: the queue module is opt-in and
 * Redis-backed, and "send this text in two hours" must work on the default zero-dependency install.
 * The tick is cheap — one indexed query on `(status, runAt)` — and a message that misses its exact
 * minute is sent on the next tick, which is the right tradeoff for a scheduled business message.
 */
@Injectable()
export class ScheduledMessageService implements OnModuleDestroy {
  private readonly logger = createLogger('ScheduledMessageService');
  private timer?: ReturnType<typeof setInterval>;
  private draining = false;
  private messagePort?: PluginMessagePort;

  constructor(
    @InjectRepository(ScheduledMessage, 'data') private readonly scheduled: Repository<ScheduledMessage>,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /** Started by the module's bootstrap hook, so unit tests that construct the service stay inert. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.drain().catch(() => undefined), TICK_MS);
    // Never hold the process open for a timer whose only job is background housekeeping.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  list(filters: { sessionId?: string; status?: ScheduledMessageStatus } = {}): Promise<ScheduledMessage[]> {
    const where: Record<string, unknown> = {};
    if (filters.sessionId) where.sessionId = filters.sessionId;
    if (filters.status) where.status = filters.status;
    return this.scheduled.find({ where, order: { runAt: 'ASC' }, take: 200 });
  }

  create(input: { sessionId: string; chatId: string; body: string; runAt: Date; createdBy?: string | null }) {
    if (!(input.runAt instanceof Date) || Number.isNaN(input.runAt.getTime())) {
      throw new BadRequestException('A valid send time is required');
    }
    // A past time is a mistake worth surfacing, not something to silently send immediately.
    if (input.runAt.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('The scheduled time is in the past');
    }
    return this.scheduled.save(
      this.scheduled.create({
        sessionId: input.sessionId,
        chatId: input.chatId,
        body: input.body,
        runAt: input.runAt,
        createdBy: input.createdBy ?? null,
        status: ScheduledMessageStatus.PENDING,
      }),
    );
  }

  async cancel(id: string): Promise<ScheduledMessage> {
    const row = await this.scheduled.findOne({ where: { id } });
    if (!row) throw new NotFoundException(`Scheduled message ${id} not found`);
    if (row.status !== ScheduledMessageStatus.PENDING) {
      throw new BadRequestException(`This message is already ${row.status} and can no longer be cancelled`);
    }
    row.status = ScheduledMessageStatus.CANCELLED;
    return this.scheduled.save(row);
  }

  /**
   * Send everything that is due.
   *
   * `draining` is a re-entrancy guard: a slow send must not let the next tick pick up the same rows
   * and send them twice. Each row is marked terminal before the next is attempted, so a crash
   * mid-batch loses at most the row in flight rather than replaying the batch.
   */
  async drain(now: Date = new Date()): Promise<{ sent: number; failed: number }> {
    if (this.draining) return { sent: 0, failed: 0 };
    this.draining = true;
    let sent = 0;
    let failed = 0;
    try {
      const due = await this.scheduled.find({
        where: { status: ScheduledMessageStatus.PENDING, runAt: LessThanOrEqual(now) },
        order: { runAt: 'ASC' },
        take: BATCH_SIZE,
      });
      if (due.length === 0) return { sent: 0, failed: 0 };

      const port = this.resolveMessagePort();
      if (!port) {
        this.logger.warn('Scheduled messages are due but the message port is unavailable', { due: due.length });
        return { sent: 0, failed: 0 };
      }

      for (const row of due) {
        try {
          await port.sendText(row.sessionId, { chatId: row.chatId, text: row.body });
          row.status = ScheduledMessageStatus.SENT;
          row.sentAt = new Date();
          sent += 1;
        } catch (error) {
          // Terminal on first failure, with the reason recorded. Silent retries would re-run a send
          // the operator cannot see, which is exactly the wrong behaviour for outbound messaging.
          row.status = ScheduledMessageStatus.FAILED;
          row.error = (error instanceof Error ? error.message : String(error)).slice(0, 240);
          failed += 1;
        }
        await this.scheduled.save(row);
      }
    } catch (error) {
      this.logger.warn('Scheduled message drain failed', { error: String(error) });
    } finally {
      this.draining = false;
    }
    return { sent, failed };
  }

  private resolveMessagePort(): PluginMessagePort | undefined {
    if (!this.messagePort) {
      try {
        this.messagePort = this.moduleRef?.get<typeof PLUGIN_MESSAGE_PORT, PluginMessagePort>(PLUGIN_MESSAGE_PORT, {
          strict: false,
        });
      } catch {
        return undefined;
      }
    }
    return this.messagePort;
  }
}
