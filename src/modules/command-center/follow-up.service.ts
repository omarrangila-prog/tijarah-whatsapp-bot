import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThanOrEqual, Repository } from 'typeorm';
import { FollowUp, FollowUpStatus } from './entities/follow-up.entity';

export interface FollowUpInput {
  conversationId?: string | null;
  assigneeId?: string | null;
  title: string;
  notes?: string | null;
  dueAt: Date;
  createdVia?: string;
}

/** Dated reminders. A follow-up never sends anything — it only surfaces work in the UI. */
@Injectable()
export class FollowUpService {
  constructor(@InjectRepository(FollowUp, 'data') private readonly followUps: Repository<FollowUp>) {}

  list(filters: { status?: FollowUpStatus; assigneeId?: string; conversationId?: string; dueBefore?: Date } = {}) {
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.assigneeId) where.assigneeId = filters.assigneeId;
    if (filters.conversationId) where.conversationId = filters.conversationId;
    if (filters.dueBefore) where.dueAt = LessThanOrEqual(filters.dueBefore);
    return this.followUps.find({ where, order: { dueAt: 'ASC' }, take: 200 });
  }

  create(input: FollowUpInput): Promise<FollowUp> {
    return this.followUps.save(
      this.followUps.create({
        conversationId: input.conversationId ?? null,
        assigneeId: input.assigneeId ?? null,
        title: input.title.trim(),
        notes: input.notes ?? null,
        dueAt: input.dueAt,
        createdVia: input.createdVia ?? 'manual',
        status: FollowUpStatus.PENDING,
      }),
    );
  }

  async setStatus(id: string, status: FollowUpStatus): Promise<FollowUp> {
    const followUp = await this.followUps.findOne({ where: { id } });
    if (!followUp) throw new NotFoundException(`Follow-up ${id} not found`);
    followUp.status = status;
    followUp.completedAt = status === FollowUpStatus.DONE ? new Date() : null;
    return this.followUps.save(followUp);
  }

  async remove(id: string): Promise<void> {
    const result = await this.followUps.delete({ id });
    if (!result.affected) throw new NotFoundException(`Follow-up ${id} not found`);
  }
}
