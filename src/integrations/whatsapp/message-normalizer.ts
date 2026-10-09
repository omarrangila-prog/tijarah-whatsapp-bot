/**
 * Turns an engine's inbound message into the agent's normalized envelope.
 *
 * Everything here is defensive. The input is shaped by whichever engine is live, both of
 * which add and rename fields between releases, and it carries content written by a member
 * of the public. A normalizer that throws on an unexpected shape costs a received message;
 * one that trusts a field costs rather more.
 */

import type { AgentAttachment, AgentMessageType, NormalizedAgentMessage, SenderRole } from './agent-message.types';

/** The subset of the engine's inbound message this needs. Kept structural, not imported. */
export interface EngineInboundMessage {
  id?: string;
  from?: string;
  author?: string;
  senderPhone?: string;
  body?: string;
  caption?: string;
  type?: string;
  timestamp?: number | string;
  fromMe?: boolean;
  isGroupMsg?: boolean;
  mimetype?: string;
  filename?: string;
  size?: number;
  mediaKey?: string;
  contact?: { pushName?: string; name?: string; formattedName?: string };
  quotedMsgId?: string;
}

const MEDIA_TYPES: Record<string, AgentMessageType> = {
  image: 'image',
  document: 'document',
  audio: 'audio',
  ptt: 'audio',
  // Both engines type a recorded voice note as 'voice'. Without this it read as an empty TEXT message.
  voice: 'audio',
  video: 'video',
  location: 'location',
};

/**
 * The most a customer may say in one turn.
 *
 * A long message is not itself an attack, but an unbounded one is a cheap way to push a
 * system prompt out of a model's attention window, and it costs tokens on every retry.
 * Truncation is visible in the stored turn rather than silent.
 */
export const MAX_INBOUND_TEXT = 4000;

/**
 * Extracts the phone number from a WhatsApp JID.
 *
 * A JID is `<number>@c.us` for a person and `<id>@g.us` for a group; newer engines also emit
 * `<lid>@lid` for privacy-forwarded senders, where the left half is NOT a phone number. That
 * last case returns null rather than a plausible-looking wrong number, because a wrong
 * number here means the agent answers one customer's question with another's data.
 */
export function phoneFromJid(jid: string | undefined | null): string | null {
  if (!jid) return null;
  const [local, domain] = String(jid).split('@');
  if (!local || !domain) return null;
  if (domain === 'lid') return null;
  if (domain === 'g.us') return null;
  const digits = local.split(':')[0].replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/** E.164 with a leading `+`, which is the form a person recognises and the allowlist stores. */
export function toDisplayPhone(digits: string | null): string | null {
  return digits ? `+${digits}` : null;
}

export interface NormalizeContext {
  sessionId: string;
  /** Decided by ContactMapper before normalization — never inferred from the message. */
  senderRole: SenderRole;
  internalConversationId: string | null;
  contactId: string | null;
}

export function normalizeInbound(raw: EngineInboundMessage, context: NormalizeContext): NormalizedAgentMessage | null {
  // The account's own outbound echo is not a turn to reason about.
  if (raw.fromMe) return null;

  const chatId = String(raw.from ?? '');
  if (!chatId) return null;

  const isGroup = Boolean(raw.isGroupMsg) || chatId.endsWith('@g.us');
  // In a group the sender is `author`; in a direct chat it is the chat itself.
  const senderJid = isGroup ? (raw.author ?? '') : chatId;
  const digits = raw.senderPhone?.replace(/\D/g, '') || phoneFromJid(senderJid);
  const senderPhone = toDisplayPhone(digits);
  if (!senderPhone) return null;

  const engineType = String(raw.type ?? 'text').toLowerCase();
  const messageType: AgentMessageType = MEDIA_TYPES[engineType] ?? (engineType === 'chat' ? 'text' : 'text');

  const bodyText = String(raw.body ?? raw.caption ?? '');
  const text = bodyText.length > MAX_INBOUND_TEXT ? `${bodyText.slice(0, MAX_INBOUND_TEXT)}…[truncated]` : bodyText;

  const attachments: AgentAttachment[] = [];
  if (messageType !== 'text' && messageType !== 'location') {
    attachments.push({
      type: messageType,
      // The engine's own reference. Resolved to bytes by MediaHandler, under limits, and
      // never exposed to the model as a path.
      reference: String(raw.id ?? ''),
      mimeType: raw.mimetype ?? null,
      fileName: raw.filename ?? null,
      byteSize: typeof raw.size === 'number' ? raw.size : null,
      caption: raw.caption ? String(raw.caption).slice(0, MAX_INBOUND_TEXT) : null,
    });
  }

  return {
    channel: 'whatsapp',
    messageId: String(raw.id ?? ''),
    senderPhone,
    senderRole: context.senderRole,
    // Keyed on the counterparty, so a customer messaging from the same number always lands
    // in one thread regardless of which session received it.
    conversationId: `whatsapp:${senderPhone}`,
    messageType,
    text,
    attachments,
    timestamp: normalizeTimestamp(raw.timestamp),
    sessionId: context.sessionId,
    chatId,
    internalConversationId: context.internalConversationId,
    contactId: context.contactId,
    senderName: raw.contact?.pushName ?? raw.contact?.name ?? raw.contact?.formattedName ?? null,
    isGroup,
  };
}

/** Engines send unix seconds, unix milliseconds, or an ISO string depending on version. */
function normalizeTimestamp(value: number | string | undefined): string {
  if (typeof value === 'string' && value.includes('-')) {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // Anything below this is seconds; above it, milliseconds. The boundary is far enough
    // from both real ranges that it cannot misclassify a plausible timestamp.
    return new Date(numeric < 1e11 ? numeric * 1000 : numeric).toISOString();
  }
  return new Date().toISOString();
}
