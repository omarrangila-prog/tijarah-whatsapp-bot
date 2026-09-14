import { Inject, Injectable } from '@nestjs/common';
import { createLogger } from '../../common/services/logger.service';
import { AgentRuntime } from '../../modules/agent/agent-runtime.service';
import { ContactMapper } from './contact-mapper';
import { MediaHandler } from './media-handler';
import { normalizeInbound, type EngineInboundMessage } from './message-normalizer';
import { WHATSAPP_PROVIDER, type WhatsAppProvider } from './whatsapp-provider.interface';
import type { AgentSystemEvent, NormalizedAgentMessage } from './agent-message.types';

/**
 * The channel adapter: WhatsApp in, agent, WhatsApp out.
 *
 * Everything here is glue, on purpose. It resolves who is talking, converts their message
 * into the agent's input format, hands it over, and sends back what comes out. It makes no
 * decisions about permissions, tools or wording — those belong to the runtime and the
 * permission layer, and a gateway that also had opinions about them would be a second place
 * to change when a rule changes.
 *
 * The contract with the caller is fail-open: `handleInbound` never throws. It is invoked
 * from the message projector, which is on the path of every received message, and a broken
 * agent must never cost the inbox a message.
 */
@Injectable()
export class WhatsAppGateway {
  private readonly logger = createLogger('WhatsAppGateway');

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly contacts: ContactMapper,
    private readonly media: MediaHandler,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  /**
   * One inbound message, end to end.
   *
   * Returns the reply it sent, or null when the correct behaviour was silence — an
   * unknown number under the ignore policy, a group message, a duplicate delivery. Silence
   * is a real outcome here and is recorded as one, not treated as a failure.
   */
  async handleInbound(
    sessionId: string,
    raw: EngineInboundMessage,
  ): Promise<{ replied: boolean; text: string | null }> {
    try {
      // The sender's identity is resolved BEFORE normalization, so the role travels on the
      // envelope and nothing downstream has to work it out from the message.
      const senderJid = raw.isGroupMsg ? (raw.author ?? '') : (raw.from ?? '');
      const probe = raw.senderPhone ?? senderJid;
      const sender = await this.contacts.resolveSender(probe);

      const message = normalizeInbound(raw, {
        sessionId,
        senderRole: sender.role,
        internalConversationId: null,
        contactId: sender.contactId,
      });
      if (!message) return { replied: false, text: null };

      // Attachments are screened before the agent is told they exist, so an oversized or
      // unsupported file becomes a sentence rather than a fetch.
      for (const attachment of message.attachments) {
        const verdict = this.media.acceptInbound(attachment.mimeType, attachment.byteSize);
        if (!verdict.ok) {
          await this.reply(message, verdict.reason ?? 'I cannot read that file.');
          return { replied: true, text: verdict.reason };
        }
      }

      const result = await this.runtime.handle(message);
      if (!result.shouldReply) return { replied: false, text: null };

      await this.reply(message, result.text);
      return { replied: true, text: result.text };
    } catch (error) {
      // Fail open. The projector's contract is that a business rule cannot cost a message.
      this.logger.error(`agent gateway failed: ${(error as Error).message}`);
      return { replied: false, text: null };
    }
  }

  /**
   * Sends the agent's reply on the session the message arrived on.
   *
   * Never on a configured default. Answering a customer from a different number than the
   * one they wrote to is confusing, and if that number belongs to another part of the
   * business it is a disclosure.
   */
  private async reply(message: NormalizedAgentMessage, text: string): Promise<void> {
    if (!text.trim()) return;
    try {
      await this.provider.sendText({ sessionId: message.sessionId, chatId: message.chatId, text });
    } catch (error) {
      this.logger.warn(`could not deliver agent reply: ${(error as Error).message}`);
    }
  }

  /**
   * A scheduled or system-raised event (brief §11).
   *
   * Deliberately routed through the same runtime as a human's message rather than sending
   * directly. A scheduler with its own send path would be a second route to a customer that
   * bypasses the permission layer, the quiet hours and the daily caps — which is precisely
   * the thing those controls exist to prevent.
   */
  async handleSystemEvent(
    event: AgentSystemEvent,
    sessionId: string,
  ): Promise<{ handled: boolean; text: string | null }> {
    try {
      const synthetic: NormalizedAgentMessage = {
        channel: 'whatsapp',
        // Prefixed so a system turn can never collide with a real message id, and is
        // obvious as a system turn in the audit trail.
        messageId: `system:${event.eventKey}`,
        senderPhone: 'system',
        // System events act with staff authority: they may prepare, and an administrator
        // approves. An event that could send unattended would make the scheduler the
        // widest-privileged actor in the system.
        senderRole: 'staff',
        conversationId: `system:${event.eventType}`,
        messageType: 'text',
        text: describeEvent(event),
        attachments: [],
        timestamp: event.occurredAt,
        sessionId,
        chatId: '',
        internalConversationId: null,
        contactId: event.subjectContactId,
        senderName: 'Scheduled event',
        isGroup: false,
      };

      const result = await this.runtime.handle(synthetic);
      return { handled: true, text: result.text };
    } catch (error) {
      this.logger.error(`system event failed: ${(error as Error).message}`);
      return { handled: false, text: null };
    }
  }

  async status(sessionId: string) {
    return this.provider.getStatus(sessionId);
  }
}

/** Renders an event as the instruction the agent reasons about. */
function describeEvent(event: AgentSystemEvent): string {
  const subject = event.subjectPhone ? ` for ${event.subjectPhone}` : '';
  switch (event.eventType) {
    case 'invoice_overdue':
      return `An invoice has become overdue${subject}. Prepare an appropriate reminder for approval.`;
    case 'payment_due':
      return `A payment is due${subject}. Prepare a courteous reminder for approval.`;
    case 'promise_date_passed':
      return `A promised payment date has passed${subject}. Prepare a follow-up for approval.`;
    case 'payment_received':
      return `A payment has been received${subject}. Cancel any pending reminders for them.`;
    case 'daily_summary':
      return 'Produce the daily receivables summary for the administrators.';
    case 'escalation':
      return `This account needs a manager's attention${subject}.`;
    case 'message_retry':
      return `A message failed to send${subject}. Report it; do not retry without approval.`;
    default:
      return `A ${String(event.eventType)} event occurred${subject}.`;
  }
}
