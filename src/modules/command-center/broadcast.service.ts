import { BadRequestException, Injectable, NotFoundException, OnModuleDestroy, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { Broadcast, BroadcastStatus, type BroadcastAudience } from './entities/broadcast.entity';
import { BroadcastRecipient, BroadcastRecipientStatus } from './entities/broadcast-recipient.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { ContactConsent, ConsentStatus } from './entities/contact-consent.entity';
import { Conversation } from './entities/conversation.entity';
import { ConversationTag } from './entities/conversation-tag.entity';
import { interpolate, normalizeWaId, phoneFromWaId } from './conversation-state';

/**
 * Floor on the gap between two sends in a campaign.
 *
 * WhatsApp treats a burst of unsolicited messages from one number as exactly what it looks like.
 * The operator can slow a campaign down but not speed it past this — the floor protects the
 * number, and the number is the business.
 */
const MIN_THROTTLE_MS = 1500;

/** How often the sender wakes to push the next slice of an in-flight campaign. */
const TICK_MS = 5000;

/** Sends attempted per tick, on top of the per-send throttle. */
const BATCH_SIZE = 5;

export interface AudiencePreview {
  /** Everyone the filters matched, before consent. */
  matched: number;
  /** The subset that has actually opted in — the only people who will be messaged. */
  optedIn: number;
  /** Matched contacts excluded for lack of consent. Shown so the gap is visible, not hidden. */
  excludedNoConsent: number;
  sample: Array<{ waId: string; name: string | null }>;
}

/**
 * Broadcast campaigns to opted-in contacts.
 *
 * Consent is not a filter the operator composes — it is applied by this service on every path:
 * when previewing an audience, when materializing recipients at approval, and once more per
 * recipient at send time (consent can be withdrawn between those points, and the later check is
 * what makes the withdrawal effective).
 *
 * There is no import, no scrape, and no way to broadcast to an arbitrary list: the audience can
 * only be built from contacts already in this workspace, which are people who have messaged one of
 * these numbers.
 */
@Injectable()
export class BroadcastService implements OnModuleDestroy {
  private readonly logger = createLogger('BroadcastService');
  private timer?: ReturnType<typeof setInterval>;
  private sending = false;
  private messagePort?: PluginMessagePort;

  constructor(
    @InjectRepository(Broadcast, 'data') private readonly broadcasts: Repository<Broadcast>,
    @InjectRepository(BroadcastRecipient, 'data') private readonly recipients: Repository<BroadcastRecipient>,
    @InjectRepository(CustomerProfile, 'data') private readonly profiles: Repository<CustomerProfile>,
    @InjectRepository(ContactConsent, 'data') private readonly consents: Repository<ContactConsent>,
    @InjectRepository(Conversation, 'data') private readonly conversations: Repository<Conversation>,
    @InjectRepository(ConversationTag, 'data') private readonly conversationTags: Repository<ConversationTag>,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ------------------------------------------------------------------- CRUD

  list(): Promise<Broadcast[]> {
    return this.broadcasts.find({ order: { createdAt: 'DESC' }, take: 100 });
  }

  async get(id: string): Promise<Broadcast> {
    const broadcast = await this.broadcasts.findOne({ where: { id } });
    if (!broadcast) throw new NotFoundException(`Broadcast ${id} not found`);
    return broadcast;
  }

  create(input: Partial<Broadcast>): Promise<Broadcast> {
    return this.broadcasts.save(
      this.broadcasts.create({
        name: input.name!,
        sessionId: input.sessionId!,
        body: input.body ?? '',
        audience: input.audience ?? null,
        throttleMs: Math.max(input.throttleMs ?? 3000, MIN_THROTTLE_MS),
        status: BroadcastStatus.DRAFT,
        scheduledAt: input.scheduledAt ?? null,
      }),
    );
  }

  /** Edits are refused once a campaign is live: changing the copy mid-send would split the audience. */
  async update(id: string, input: Partial<Broadcast>): Promise<Broadcast> {
    const broadcast = await this.get(id);
    if (![BroadcastStatus.DRAFT, BroadcastStatus.PENDING_APPROVAL].includes(broadcast.status)) {
      throw new BadRequestException(`A ${broadcast.status} broadcast can no longer be edited`);
    }
    if (input.name !== undefined) broadcast.name = input.name;
    if (input.sessionId !== undefined) broadcast.sessionId = input.sessionId;
    if (input.body !== undefined) broadcast.body = input.body;
    if (input.audience !== undefined) broadcast.audience = input.audience;
    if (input.throttleMs !== undefined) broadcast.throttleMs = Math.max(input.throttleMs, MIN_THROTTLE_MS);
    if (input.scheduledAt !== undefined) broadcast.scheduledAt = input.scheduledAt;
    return this.broadcasts.save(broadcast);
  }

  async remove(id: string): Promise<void> {
    const broadcast = await this.get(id);
    if (broadcast.status === BroadcastStatus.SENDING) {
      throw new BadRequestException('Pause the broadcast before deleting it');
    }
    await this.recipients.delete({ broadcastId: id });
    await this.broadcasts.delete({ id });
  }

  listRecipients(broadcastId: string, status?: BroadcastRecipientStatus): Promise<BroadcastRecipient[]> {
    return this.recipients.find({
      where: status ? { broadcastId, status } : { broadcastId },
      order: { createdAt: 'ASC' },
      take: 500,
    });
  }

  // --------------------------------------------------------------- audience

  /**
   * Resolve an audience to the people who will actually be messaged.
   *
   * Returns both numbers — matched and opted-in — because the difference is the point: an operator
   * who filters to 500 contacts and can only message 40 needs to see that before they send, not
   * afterwards.
   */
  async previewAudience(audience: BroadcastAudience | null): Promise<AudiencePreview> {
    const matched = await this.resolveCandidates(audience);
    const optedIn = await this.consents.find({
      where: { waId: In(matched.length ? matched.map(m => m.waId) : ['__none__']), status: ConsentStatus.OPTED_IN },
    });
    const optedInIds = new Set(optedIn.map(c => c.waId));
    const eligible = matched.filter(m => optedInIds.has(m.waId));
    return {
      matched: matched.length,
      optedIn: eligible.length,
      excludedNoConsent: matched.length - eligible.length,
      sample: eligible.slice(0, 10),
    };
  }

  /** Candidate contacts for an audience, before consent is applied. */
  private async resolveCandidates(
    audience: BroadcastAudience | null,
  ): Promise<Array<{ waId: string; name: string | null }>> {
    const qb = this.profiles.createQueryBuilder('p');
    if (audience?.customerType) qb.andWhere('p.customerType = :customerType', { customerType: audience.customerType });
    if (audience?.city) qb.andWhere('p.city = :city', { city: audience.city });

    if (audience?.sessionIds?.length) {
      // "Has talked to these numbers" is expressed through conversations, since that is where the
      // person↔number relationship actually lives.
      const conversations = await this.conversations.find({
        where: { sessionId: In(audience.sessionIds) },
        select: { chatId: true },
      });
      const waIds = [...new Set(conversations.map(c => normalizeWaId(c.chatId)))];
      if (waIds.length === 0) return [];
      qb.andWhere('p.waId IN (:...waIds)', { waIds });
    }

    if (audience?.tagIds?.length) {
      const links = await this.conversationTags.find({ where: { tagId: In(audience.tagIds) } });
      if (links.length === 0) return [];
      const tagged = await this.conversations.find({ where: { id: In(links.map(l => l.conversationId)) } });
      const waIds = [...new Set(tagged.map(c => normalizeWaId(c.chatId)))];
      if (waIds.length === 0) return [];
      qb.andWhere('p.waId IN (:...tagWaIds)', { tagWaIds: waIds });
    }

    // Groups and channels are never broadcast targets — a campaign addresses people.
    qb.andWhere("p.waId LIKE '%@c.us'");
    const rows = await qb.take(5000).getMany();
    return rows.map(row => ({ waId: row.waId, name: row.displayName }));
  }

  // ------------------------------------------------------------- lifecycle

  /** Lock the audience and copy, and wait for a human. Nothing is sent in this state. */
  async submitForApproval(id: string): Promise<Broadcast> {
    const broadcast = await this.get(id);
    if (broadcast.status !== BroadcastStatus.DRAFT) {
      throw new BadRequestException(`Only a draft can be submitted for approval (this one is ${broadcast.status})`);
    }
    if (!broadcast.body.trim()) throw new BadRequestException('Write the message before submitting for approval');
    broadcast.status = BroadcastStatus.PENDING_APPROVAL;
    return this.broadcasts.save(broadcast);
  }

  /**
   * Approve: materialize the recipient rows from the consented audience and start (or schedule).
   *
   * Materializing here rather than at send time is what makes progress, pause and failure reporting
   * meaningful — the denominator is fixed at approval, so "142 of 380" is a real fraction.
   */
  async approve(id: string, approvedBy: string | null): Promise<Broadcast> {
    const broadcast = await this.get(id);
    if (broadcast.status !== BroadcastStatus.PENDING_APPROVAL) {
      throw new BadRequestException('This broadcast is not awaiting approval');
    }

    const candidates = await this.resolveCandidates(broadcast.audience);
    const consented = await this.consents.find({
      where: {
        waId: In(candidates.length ? candidates.map(c => c.waId) : ['__none__']),
        status: ConsentStatus.OPTED_IN,
      },
    });
    const allowed = new Set(consented.map(c => c.waId));
    const eligible = candidates.filter(c => allowed.has(c.waId));

    if (eligible.length === 0) {
      throw new BadRequestException(
        'No opted-in contacts match this audience. A broadcast can only be sent to contacts who have opted in.',
      );
    }

    await this.recipients.delete({ broadcastId: id });
    // Chunked so a large audience does not build one enormous INSERT.
    for (let index = 0; index < eligible.length; index += 500) {
      await this.recipients.save(
        eligible.slice(index, index + 500).map(person =>
          this.recipients.create({
            broadcastId: id,
            waId: person.waId,
            name: person.name,
            status: BroadcastRecipientStatus.PENDING,
          }),
        ),
      );
    }

    broadcast.approvedBy = approvedBy;
    broadcast.approvedAt = new Date();
    broadcast.totalRecipients = eligible.length;
    broadcast.sentCount = 0;
    broadcast.failedCount = 0;
    const scheduledForLater = broadcast.scheduledAt && broadcast.scheduledAt.getTime() > Date.now();
    broadcast.status = scheduledForLater ? BroadcastStatus.SCHEDULED : BroadcastStatus.SENDING;
    if (!scheduledForLater) broadcast.startedAt = new Date();
    return this.broadcasts.save(broadcast);
  }

  async pause(id: string): Promise<Broadcast> {
    const broadcast = await this.get(id);
    if (![BroadcastStatus.SENDING, BroadcastStatus.SCHEDULED].includes(broadcast.status)) {
      throw new BadRequestException('Only a sending or scheduled broadcast can be paused');
    }
    broadcast.status = BroadcastStatus.PAUSED;
    return this.broadcasts.save(broadcast);
  }

  async resume(id: string): Promise<Broadcast> {
    const broadcast = await this.get(id);
    if (broadcast.status !== BroadcastStatus.PAUSED) throw new BadRequestException('This broadcast is not paused');
    broadcast.status = BroadcastStatus.SENDING;
    broadcast.startedAt = broadcast.startedAt ?? new Date();
    return this.broadcasts.save(broadcast);
  }

  async cancel(id: string): Promise<Broadcast> {
    const broadcast = await this.get(id);
    if ([BroadcastStatus.COMPLETED, BroadcastStatus.CANCELLED].includes(broadcast.status)) {
      throw new BadRequestException(`This broadcast is already ${broadcast.status}`);
    }
    broadcast.status = BroadcastStatus.CANCELLED;
    broadcast.completedAt = new Date();
    return this.broadcasts.save(broadcast);
  }

  // ----------------------------------------------------------------- sender

  /** Promote due scheduled campaigns, then push one slice of each sending campaign. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      const scheduled = await this.broadcasts.find({ where: { status: BroadcastStatus.SCHEDULED } });
      for (const broadcast of scheduled) {
        if (broadcast.scheduledAt && broadcast.scheduledAt.getTime() <= now.getTime()) {
          broadcast.status = BroadcastStatus.SENDING;
          broadcast.startedAt = broadcast.startedAt ?? now;
          await this.broadcasts.save(broadcast);
        }
      }
      const active = await this.broadcasts.find({ where: { status: BroadcastStatus.SENDING } });
      for (const broadcast of active) await this.sendSlice(broadcast);
    } catch (error) {
      this.logger.warn('Broadcast tick failed', { error: String(error) });
    } finally {
      this.sending = false;
    }
  }

  private async sendSlice(broadcast: Broadcast): Promise<void> {
    const pending = await this.recipients.find({
      where: { broadcastId: broadcast.id, status: BroadcastRecipientStatus.PENDING },
      order: { createdAt: 'ASC' },
      take: BATCH_SIZE,
    });

    if (pending.length === 0) {
      broadcast.status = BroadcastStatus.COMPLETED;
      broadcast.completedAt = new Date();
      await this.broadcasts.save(broadcast);
      this.logger.log('Broadcast completed', {
        broadcastId: broadcast.id,
        sent: broadcast.sentCount,
        failed: broadcast.failedCount,
      });
      return;
    }

    const port = this.resolveMessagePort();
    if (!port) return;
    const throttle = Math.max(broadcast.throttleMs, MIN_THROTTLE_MS);

    for (const recipient of pending) {
      // Re-read the campaign's own state between sends: a pause pressed mid-slice must take effect
      // now, not after the slice finishes.
      const current = await this.broadcasts.findOne({ where: { id: broadcast.id } });
      if (!current || current.status !== BroadcastStatus.SENDING) return;

      // Consent is re-checked per recipient. Someone who opted out after approval must not be
      // messaged, and skipping them is recorded rather than silently dropped.
      const consent = await this.consents.findOne({ where: { waId: recipient.waId } });
      if (consent?.status !== ConsentStatus.OPTED_IN) {
        recipient.status = BroadcastRecipientStatus.SKIPPED;
        recipient.error = 'Consent was withdrawn before this message was sent';
        await this.recipients.save(recipient);
        continue;
      }

      const text = interpolate(broadcast.body, {
        name: recipient.name ?? '',
        phone: phoneFromWaId(recipient.waId) ?? '',
      });

      try {
        const result = await port.sendText(broadcast.sessionId, { chatId: recipient.waId, text });
        recipient.status = BroadcastRecipientStatus.SENT;
        recipient.waMessageId = result?.messageId ?? null;
        recipient.sentAt = new Date();
        await this.broadcasts.increment({ id: broadcast.id }, 'sentCount', 1);
      } catch (error) {
        recipient.status = BroadcastRecipientStatus.FAILED;
        recipient.error = (error instanceof Error ? error.message : String(error)).slice(0, 240);
        await this.broadcasts.increment({ id: broadcast.id }, 'failedCount', 1);
      }
      await this.recipients.save(recipient);
      await delay(throttle);
    }
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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
