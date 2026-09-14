import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan, In } from 'typeorm';
import { createHash, randomUUID } from 'node:crypto';
import { createLogger } from '../../common/services/logger.service';
import { AgentApproval, type ApprovalState } from './entities/agent-approval.entity';
import { AgentSettings } from './entities/agent-settings.entity';
import { normalizePhone } from '../../integrations/whatsapp/contact-mapper';

/**
 * Prepared actions and the replies that decide them (brief §8).
 *
 * The lifecycle is deliberately narrow: an approval is created with everything needed to
 * execute it, an authorised person replies, and it runs exactly once. The interesting parts
 * are all refusals.
 */

export interface CreateApprovalInput {
  toolName: string;
  toolInput: Record<string, unknown>;
  summary: string;
  requestedByPhone: string;
  recipientPhone?: string | null;
  recipientLabel?: string | null;
  verifiedContext?: Record<string, unknown> | null;
  conversationId?: string | null;
  turnId?: string | null;
}

export type ApprovalCommand =
  | { kind: 'approve'; reference: string }
  | { kind: 'cancel'; reference: string }
  | { kind: 'edit'; reference: string; newText: string | null }
  | { kind: 'none' };

export interface ApprovalGrant {
  ok: boolean;
  approval: AgentApproval | null;
  /** A sentence to send back. Always populated, including on success. */
  message: string;
}

@Injectable()
export class ApprovalService {
  private readonly logger = createLogger('ApprovalService');

  constructor(
    @InjectRepository(AgentApproval, 'data') private readonly approvals: Repository<AgentApproval>,
    @InjectRepository(AgentSettings, 'data') private readonly settings: Repository<AgentSettings>,
  ) {}

  /**
   * Parses an approval reply.
   *
   * Only an exact command shape counts. A message that merely contains the word "approve"
   * near a reference — "did you approve APR-1001 yet?" — must not execute anything, so the
   * verb has to lead and the reference has to be the operand.
   */
  static parseCommand(text: string): ApprovalCommand {
    const trimmed = String(text ?? '').trim();
    const match = trimmed.match(/^(approve|approved|ok|yes|cancel|reject|no|edit)\s+(APR-\d{3,10})\b([\s\S]*)$/i);
    if (!match) return { kind: 'none' };

    const verb = match[1].toLowerCase();
    const reference = match[2].toUpperCase();
    const rest = (match[3] ?? '').trim();

    if (verb === 'cancel' || verb === 'reject' || verb === 'no') return { kind: 'cancel', reference };
    if (verb === 'edit') return { kind: 'edit', reference, newText: rest.length > 0 ? rest : null };
    return { kind: 'approve', reference };
  }

  async create(input: CreateApprovalInput): Promise<AgentApproval> {
    const settings = await this.loadSettings();
    const reference = await this.nextReference();

    const approval = this.approvals.create({
      reference,
      toolName: input.toolName,
      toolInput: input.toolInput,
      summary: input.summary,
      requestedByPhone: normalizePhone(input.requestedByPhone) ?? input.requestedByPhone,
      recipientPhone: normalizePhone(input.recipientPhone ?? null),
      recipientLabel: input.recipientLabel ?? null,
      verifiedContext: input.verifiedContext ?? null,
      state: 'pending',
      expiresAt: new Date(Date.now() + settings.approvalTtlMinutes * 60_000),
      conversationId: input.conversationId ?? null,
      turnId: input.turnId ?? null,
      createdAt: new Date(),
    });
    return this.approvals.save(approval);
  }

  /**
   * Sequential, human-quotable references.
   *
   * Sequential rather than random because a person has to type it back on a phone keyboard,
   * and `APR-1001` is typed correctly far more often than a uuid fragment. Guessability is
   * not a risk here: knowing a reference does nothing without also being an authorised
   * approver who did not raise the request.
   */
  private async nextReference(): Promise<string> {
    const latest = await this.approvals
      .createQueryBuilder('a')
      .select('a.reference')
      .orderBy('a.createdAt', 'DESC')
      .limit(1)
      .getOne();
    const previous = latest ? Number(latest.reference.replace(/\D/g, '')) : 1000;
    return `APR-${Number.isFinite(previous) ? previous + 1 : 1001}`;
  }

  /**
   * Grants an approval, with every check the brief requires.
   *
   * Order matters: identity before state, state before expiry, and the single-use claim
   * last and atomically. Checking "is it pending?" and then writing would let two APPROVE
   * replies arriving together both pass, so the claim is a conditional UPDATE and the loser
   * is told it was already used.
   */
  async approve(reference: string, approverPhone: string, approverRole: string): Promise<ApprovalGrant> {
    const approval = await this.approvals.findOne({ where: { reference: reference.toUpperCase() } });
    if (!approval) {
      return { ok: false, approval: null, message: `I have no record of ${reference}.` };
    }

    /*
     * Only an admin approves, and never their own request.
     *
     * Self-approval would make the whole gate decorative: anyone who could ask the agent to
     * send something could also authorise it. Staff may prepare; an admin decides.
     */
    if (approverRole !== 'admin') {
      return { ok: false, approval, message: 'Only an administrator can approve an action.' };
    }
    const approver = normalizePhone(approverPhone);
    if (approver && approver === approval.requestedByPhone) {
      return {
        ok: false,
        approval,
        message: `${approval.reference} was requested from this number, so it needs a different administrator to approve it.`,
      };
    }

    if (approval.state !== 'pending') {
      return {
        ok: false,
        approval,
        message:
          approval.state === 'executed'
            ? `${approval.reference} has already been sent.`
            : `${approval.reference} is ${approval.state} and can no longer be approved.`,
      };
    }

    if (approval.expiresAt.getTime() < Date.now()) {
      await this.approvals.update({ id: approval.id, state: 'pending' }, { state: 'expired' });
      return {
        ok: false,
        approval,
        message: `${approval.reference} expired. Ask me to prepare it again and I will recheck the figures.`,
      };
    }

    // The atomic claim. `state = 'pending'` in the WHERE is what makes this single-use.
    const idempotencyKey = createHash('sha256')
      .update(`${approval.id}:${approver ?? 'unknown'}`)
      .digest('hex')
      .slice(0, 40);

    const claimed = await this.approvals.update(
      { id: approval.id, state: 'pending' },
      { state: 'approved', decidedByPhone: approver, decidedAt: new Date(), idempotencyKey },
    );
    if (!claimed.affected) {
      return { ok: false, approval, message: `${approval.reference} was already decided.` };
    }

    const fresh = await this.approvals.findOne({ where: { id: approval.id } });
    return { ok: true, approval: fresh, message: `${approval.reference} approved.` };
  }

  async reject(reference: string, approverPhone: string): Promise<ApprovalGrant> {
    const approval = await this.approvals.findOne({ where: { reference: reference.toUpperCase() } });
    if (!approval) return { ok: false, approval: null, message: `I have no record of ${reference}.` };
    if (approval.state !== 'pending') {
      return { ok: false, approval, message: `${approval.reference} is already ${approval.state}.` };
    }
    await this.approvals.update(
      { id: approval.id, state: 'pending' },
      { state: 'rejected', decidedByPhone: normalizePhone(approverPhone), decidedAt: new Date() },
    );
    return { ok: true, approval, message: `${approval.reference} cancelled. Nothing was sent.` };
  }

  /** Records the outcome of executing an approved action. */
  async markExecuted(id: string, messageId: string | null): Promise<void> {
    await this.approvals.update({ id }, { state: 'executed', resultMessageId: messageId });
  }

  async markFailed(id: string, reason: string): Promise<void> {
    await this.approvals.update({ id }, { state: 'failed', failureReason: reason.slice(0, 500) });
  }

  /**
   * Expires everything past its deadline.
   *
   * Run on a schedule and also read defensively at approval time, because a pending row
   * whose deadline passed is expired whether or not the sweeper has run yet — the sweeper
   * is for the dashboard's benefit, not for correctness.
   */
  async expireStale(): Promise<number> {
    const result = await this.approvals.update(
      { state: 'pending', expiresAt: LessThan(new Date()) },
      { state: 'expired' },
    );
    return result.affected ?? 0;
  }

  async listPending(limit = 50): Promise<AgentApproval[]> {
    return this.approvals.find({ where: { state: 'pending' }, order: { createdAt: 'DESC' }, take: limit });
  }

  async listRecent(states: ApprovalState[], limit = 100): Promise<AgentApproval[]> {
    return this.approvals.find({ where: { state: In(states) }, order: { createdAt: 'DESC' }, take: limit });
  }

  async findByReference(reference: string): Promise<AgentApproval | null> {
    return this.approvals.findOne({ where: { reference: reference.toUpperCase() } });
  }

  private async loadSettings(): Promise<AgentSettings> {
    const existing = await this.settings.findOne({ where: { id: 'default' } });
    if (existing) return existing;
    return this.settings.save(this.settings.create({ id: 'default' }));
  }

  /** Used by the runtime to attach a fresh idempotency key when it executes. */
  static executionKey(approvalId: string): string {
    return `apr:${approvalId}:${randomUUID().slice(0, 8)}`;
  }
}
