import { Injectable } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { ConversationService, type RecordedMessage } from './conversation.service';
import { CustomerService } from './customer.service';
import { AutomationFlowService } from './automation-flow.service';
import { RoutingService } from './routing.service';
import { normalizeWaId } from './conversation-state';

/** The message shape the projector hands over — a loose record, since it comes off the wire. */
export interface ProjectedMessage {
  chatId?: unknown;
  chatName?: unknown;
  body?: unknown;
  type?: unknown;
  timestamp?: unknown;
  kind?: unknown;
  fromMe?: unknown;
  contact?: { name?: unknown; pushName?: unknown };
}

/**
 * The single seam between OpenWA's message pipeline and the command center.
 *
 * `MessageProjector` calls exactly two methods here, fire-and-forget, from the same at-most-once
 * dispatch stage that already drives webhooks and autoreply rules. Everything this service touches
 * is `cc_*` — it never writes to `messages`, `sessions` or anything else OpenWA owns.
 *
 * Every method swallows its own failures. A broken conversation index, a full disk or a bad
 * automation rule must degrade to "the inbox is stale" and never to a dropped WhatsApp message.
 */
@Injectable()
export class ConversationRecorder {
  private readonly logger = createLogger('ConversationRecorder');

  constructor(
    private readonly conversations: ConversationService,
    private readonly customers: CustomerService,
    private readonly flows: AutomationFlowService,
    private readonly routing: RoutingService,
  ) {}

  /** A customer message arrived. */
  async onInbound(sessionId: string, raw: ProjectedMessage): Promise<void> {
    const message = normalize(raw);
    if (!message) return;
    try {
      const conversation = await this.conversations.recordInbound(sessionId, message);
      await this.touchCustomer(message);
      // Auto-assignment runs BEFORE the flows, so a flow's own assign action can still override the
      // router's choice — the operator's explicit rule beats the load balancer's default.
      if (conversation) await this.autoAssign(conversation.id, conversation.assigneeId);
      // Flows run after the conversation exists, so a rule can read and mutate its state.
      await this.flows.evaluateInbound(sessionId, {
        chatId: message.chatId,
        body: message.body,
        type: message.type,
        kind: message.kind,
        chatName: message.chatName,
        timestamp: message.timestamp,
        fromMe: false,
      });
    } catch (error) {
      this.logger.warn('Failed to record inbound message', { sessionId, error: String(error) });
    }
  }

  /** An agent, an automation or a linked phone sent a message. */
  async onOutbound(sessionId: string, raw: ProjectedMessage): Promise<void> {
    const message = normalize(raw);
    if (!message) return;
    try {
      await this.conversations.recordOutbound(sessionId, message);
      await this.touchCustomer(message);
    } catch (error) {
      this.logger.warn('Failed to record outbound message', { sessionId, error: String(error) });
    }
  }

  /**
   * Hand an unowned conversation to an agent, if the workspace is configured to distribute work.
   *
   * Failure is swallowed like everything else on this path: a routing problem must never cost the
   * gateway an inbound message. An unassigned conversation stays in the queue, which is visible and
   * claimable — the safe outcome.
   */
  private async autoAssign(conversationId: string, currentAssignee: string | null): Promise<void> {
    if (currentAssignee) return;
    try {
      const conversation = await this.conversations.findById(conversationId);
      const decision = await this.routing.route(conversation);
      if (!decision.assignedTo) return;
      await this.conversations.assign(
        conversationId,
        { agentId: decision.assignedTo, reason: 'Auto-assigned on arrival' },
        'router',
      );
    } catch (error) {
      this.logger.warn('Auto-assignment failed; conversation stays in the queue', {
        conversationId,
        error: String(error),
      });
    }
  }

  /**
   * Keep the customer profile's interaction window current.
   *
   * Only 1:1 chats map to a person — a group chat id is not a customer, and creating a profile for
   * one would put groups in the Contacts list.
   */
  private async touchCustomer(message: RecordedMessage): Promise<void> {
    const waId = normalizeWaId(message.chatId);
    if (!waId.endsWith('@c.us')) return;
    const at = message.timestamp ? new Date(message.timestamp * 1000) : new Date();
    await this.customers.touch(waId, Number.isNaN(at.getTime()) ? new Date() : at, message.chatName ?? null);
  }
}

/** Coerce the wire payload into the recorder's shape, or null when it carries no usable chat id. */
function normalize(raw: ProjectedMessage): RecordedMessage | null {
  const chatId = typeof raw.chatId === 'string' ? raw.chatId.trim() : '';
  if (!chatId) return null;

  const contactName =
    typeof raw.contact?.name === 'string'
      ? raw.contact.name
      : typeof raw.contact?.pushName === 'string'
        ? raw.contact.pushName
        : null;

  return {
    chatId,
    chatName: typeof raw.chatName === 'string' && raw.chatName ? raw.chatName : contactName,
    body: typeof raw.body === 'string' ? raw.body : '',
    type: typeof raw.type === 'string' ? raw.type : 'text',
    timestamp: typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp) ? raw.timestamp : undefined,
    kind: typeof raw.kind === 'string' ? raw.kind : undefined,
  };
}
