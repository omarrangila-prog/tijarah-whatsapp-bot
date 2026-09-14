import { z } from 'zod';
import { ApiKeyRole } from '../../../modules/auth/entities/api-key.entity';
import { defineTool } from '../tool-descriptor';
import type { AnyToolDescriptor } from '../tool-descriptor';
import type { ScheduledMessageService } from '../../../modules/command-center/scheduled-message.service';
import type { ApprovalService } from '../../../modules/agent/approval.service';
import type { ContactMapper } from '../../../integrations/whatsapp/contact-mapper';
import type { Repository } from 'typeorm';
import type { Message } from '../../../modules/message/entities/message.entity';

/**
 * The tools the brief's §5 asks for that did not already exist.
 *
 * Most of that list is already in this registry under the names it has always had —
 * `MessageSendText`, `MessageSendDocument`, `MessageSendImage`, `MessageReply`,
 * `ContactCheckNumber`, `ContactFindAll`, `SessionGetChats`. Adding `whatsapp_send_text`
 * beside `MessageSendText` would give the model two ways to do one thing, two schemas to
 * keep in step and two places to apply a permission rule — which is the duplication the
 * brief rules out. So this file adds only the four capabilities that were genuinely
 * missing, plus the two the agent itself needs.
 *
 * Naming follows the registry's existing convention (`NounVerb`, PascalCase) rather than
 * the brief's snake_case, so the tool list a model sees stays internally consistent.
 */

const sessionId = z.string().min(1).describe('WhatsApp session id');

/**
 * Dependencies, supplied as resolvers rather than instances.
 *
 * These services live in modules this one must not import: `ScheduledMessageService` in
 * CommandCenterModule, and the agent's own services in AgentModule. Injecting them into the
 * registry factory means resolving them at container-build time, which fails when the
 * owning module has not been constructed yet — and cannot be fixed by adding imports,
 * because SessionModule already imports CommandCenterModule and must be able to reach the
 * agent, so the edge would close a cycle.
 *
 * Resolving at CALL time instead removes the ordering question entirely. It is the same
 * deferral the plugin host ports document and use for the same reason.
 */
export interface AgentToolDeps {
  scheduled: () => ScheduledMessageService;
  approvals: () => ApprovalService;
  contacts: () => ContactMapper;
  /**
   * Read directly rather than through `MessageService`.
   *
   * The service has no single-message read, and adding one to it for this would widen a
   * heavily-used public surface for one caller. A scoped repository read is the smaller
   * change, and it stays read-only by construction.
   */
  messages: () => Repository<Message>;
}

export function agentTools(deps: AgentToolDeps): AnyToolDescriptor[] {
  return [
    /**
     * CRM contact search, which is a different thing from `ContactFindAll`.
     *
     * `ContactFindAll` lists the WhatsApp address book on a session. This searches the
     * business's own customer records — company, customer type, city — which is what
     * "send Ali the statement" actually needs to resolve.
     *
     * It returns every plausible match and never a single best guess. Picking between two
     * customers called Ali is not a ranking problem: getting it wrong sends one customer
     * another customer's information.
     */
    defineTool({
      name: 'AgentSearchContacts',
      description:
        'Search the business CRM for a customer by name, company, customer type or phone number. ' +
        'Returns all plausible matches. If more than one comes back, ask the user which they mean — never choose.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({
        query: z.string().min(2).max(60).describe('Name, company, or phone number to search for'),
        limit: z.number().int().min(1).max(20).optional(),
      }),
      handler: async input => {
        const matches = await deps.contacts().searchContacts(input.query, input.limit ?? 8);
        return {
          count: matches.length,
          ambiguous: matches.length > 1,
          matches: matches.map(match => ({
            contactId: match.contactId,
            name: match.displayName,
            company: match.company,
            type: match.customerType,
            city: match.city,
            // The number is returned so a send can be prepared, but the permission layer
            // still decides whether that send may happen.
            phone: match.phoneE164,
            matchedOn: match.matchedOn,
          })),
        };
      },
    }),

    /**
     * Delivery status for a message the agent sent.
     *
     * Answers "did Ali get it?" without an operator opening the dashboard, and is read-only
     * by construction — it cannot resend, and it cannot mark anything.
     */
    defineTool({
      name: 'MessageGetStatus',
      description: 'Get the delivery status (sent, delivered, read, failed) of a message that was sent earlier.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        messageId: z.string().min(1).describe('The message id returned when the message was sent'),
      }),
      handler: async input => {
        const found = await deps.messages().findOne({
          // Scoped to the session, so a message id from one account cannot be read through another.
          where: { sessionId: input.sessionId, waMessageId: input.messageId },
        });
        if (!found) return { found: false, status: 'unknown' };
        return {
          found: true,
          id: found.waMessageId,
          status: found.status,
          direction: found.direction,
          timestamp: found.createdAt,
        };
      },
    }),

    /**
     * Send-later.
     *
     * Wraps the existing `ScheduledMessageService` rather than adding a second queue. Note
     * that scheduling is itself a write: it is subject to the same approval rules as an
     * immediate send, because "send this on Monday" is a decision to send.
     */
    defineTool({
      name: 'MessageSchedule',
      description:
        'Schedule a text message to be sent at a future time. Scheduling still requires approval — ' +
        'it is a decision to send, only later.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId,
        chatId: z.string().min(1).describe('Recipient chat JID'),
        body: z.string().min(1).max(4096),
        runAt: z.string().datetime().describe('ISO timestamp for when to send'),
        reason: z.string().max(300).optional().describe('Why this is being scheduled, for the audit trail'),
      }),
      handler: async input =>
        deps.scheduled().create({
          sessionId: input.sessionId,
          chatId: input.chatId,
          body: input.body,
          runAt: new Date(input.runAt),
          createdBy: 'agent',
        }),
    }),

    defineTool({
      name: 'MessageCancelScheduled',
      description: 'Cancel a scheduled message that has not been sent yet.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({ id: z.string().min(1).describe('The scheduled message id') }),
      handler: async input => deps.scheduled().cancel(input.id),
    }),

    defineTool({
      name: 'MessageListScheduled',
      description: 'List messages that are scheduled to be sent but have not gone out yet.',
      tier: 'read',
      requiredRole: ApiKeyRole.VIEWER,
      inputSchema: z.object({ sessionId: z.string().min(1).optional() }),
      handler: async input =>
        (await deps.scheduled().list(input.sessionId ? { sessionId: input.sessionId } : {})).map(row => ({
          id: row.id,
          chatId: row.chatId,
          body: row.body,
          runAt: row.runAt,
          status: row.status,
        })),
    }),

    /**
     * What is waiting on a human.
     *
     * Read-only and deliberately so: this tool lets the agent *report* pending approvals,
     * never decide them. Approval happens through the explicit reply command, handled
     * before any model runs — a tool that could approve would let a model be argued into
     * authorising its own request.
     */
    defineTool({
      name: 'AgentListPendingApprovals',
      description: 'List actions that are prepared and waiting for an administrator to approve.',
      tier: 'read',
      requiredRole: ApiKeyRole.OPERATOR,
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
      handler: async input => {
        const pending = await deps.approvals().listPending(input.limit ?? 20);
        return {
          count: pending.length,
          summary:
            pending.length === 0
              ? 'Nothing is waiting for approval.'
              : pending
                  .map(
                    row => `${row.reference}: ${row.toolName}${row.recipientLabel ? ` → ${row.recipientLabel}` : ''}`,
                  )
                  .join('\n'),
          approvals: pending.map(row => ({
            reference: row.reference,
            tool: row.toolName,
            recipient: row.recipientPhone,
            requestedBy: row.requestedByPhone,
            expiresAt: row.expiresAt,
          })),
        };
      },
    }),
  ];
}
