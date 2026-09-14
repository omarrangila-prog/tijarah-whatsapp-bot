import { z } from 'zod';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
import { defineTool } from '../../core/agent-tools/tool-descriptor';
import type { AnyToolDescriptor } from '../../core/agent-tools/tool-descriptor';

/**
 * Send tools that record instead of transmitting, for demonstrations.
 *
 * The registry's real send tools reach the engine, which needs a scanned WhatsApp number.
 * That is correct, and it means the last step of a demonstration — the message actually
 * going out — fails on a machine with no number attached, which reads to a client as the
 * product being broken rather than as the demo being unplugged.
 *
 * These stand in when `AGENT_WHATSAPP_MOCK=true`. They keep the same **name, tier, required
 * role, session scoping and input schema** as the tools they replace, so the approval gate,
 * the customer fence and the audit trail behave identically — the only thing that changes is
 * that the last hop writes to memory instead of to WhatsApp. Every result carries a `mock.`
 * message id and `mock: true`, so a recorded send can never be read as a real one.
 */
export const DEMO_REPLACED_TOOLS = ['MessageSendText', 'MessageSendDocument', 'MessageSendImage'] as const;

export interface DemoSendDeps {
  transport: () => {
    sendText(input: { sessionId: string; chatId: string; text: string }): Promise<{ messageId: string; mock: boolean }>;
    sendDocument(input: {
      sessionId: string;
      chatId: string;
      attachment: { kind: 'document'; data: string; fileName: string; mimeType: string };
      caption?: string;
    }): Promise<{ messageId: string; mock: boolean }>;
    sendImage(input: {
      sessionId: string;
      chatId: string;
      attachment: { kind: 'image'; data: string; fileName: string; mimeType: string };
      caption?: string;
    }): Promise<{ messageId: string; mock: boolean }>;
  };
}

export function demoSendTools(deps: DemoSendDeps): AnyToolDescriptor[] {
  const sessionScopedId = z.string().min(1).describe('WhatsApp session id');

  return [
    defineTool({
      name: 'MessageSendText',
      description:
        'Send a plain text message to a chat. DEMONSTRATION MODE: the message is recorded, not ' +
        'transmitted, and the returned id is prefixed "mock.". Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId: sessionScopedId,
        chatId: z.string().min(1).describe('Chat JID, e.g. 923214455667@c.us'),
        text: z.string().min(1).max(4096),
      }),
      handler: async input => {
        const result = await deps.transport().sendText({
          sessionId: input.sessionId,
          chatId: input.chatId,
          text: input.text,
        });
        return { id: result.messageId, mock: result.mock, to: input.chatId, delivered: 'recorded (demo mode)' };
      },
    }),

    defineTool({
      name: 'MessageSendDocument',
      description: 'Send a document to a chat. DEMONSTRATION MODE: recorded, not transmitted. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId: sessionScopedId,
        chatId: z.string().min(1),
        url: z.string().url().describe('Public URL of the document'),
        filename: z.string().max(200).optional(),
        caption: z.string().max(1024).optional(),
      }),
      handler: async input => {
        const result = await deps.transport().sendDocument({
          sessionId: input.sessionId,
          chatId: input.chatId,
          attachment: {
            kind: 'document',
            data: input.url,
            fileName: input.filename ?? 'document.pdf',
            mimeType: 'application/pdf',
          },
          caption: input.caption,
        });
        return { id: result.messageId, mock: result.mock, to: input.chatId, delivered: 'recorded (demo mode)' };
      },
    }),

    defineTool({
      name: 'MessageSendImage',
      description: 'Send an image to a chat. DEMONSTRATION MODE: recorded, not transmitted. Requires OPERATOR role.',
      tier: 'write',
      requiredRole: ApiKeyRole.OPERATOR,
      sessionScoped: true,
      inputSchema: z.object({
        sessionId: sessionScopedId,
        chatId: z.string().min(1),
        url: z.string().url(),
        caption: z.string().max(1024).optional(),
      }),
      handler: async input => {
        const result = await deps.transport().sendImage({
          sessionId: input.sessionId,
          chatId: input.chatId,
          attachment: { kind: 'image', data: input.url, fileName: 'image.jpg', mimeType: 'image/jpeg' },
          caption: input.caption,
        });
        return { id: result.messageId, mock: result.mock, to: input.chatId, delivered: 'recorded (demo mode)' };
      },
    }),
  ];
}
