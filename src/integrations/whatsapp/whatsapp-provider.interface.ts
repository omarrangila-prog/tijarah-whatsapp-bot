/**
 * The WhatsApp transport seam.
 *
 * The runtime depends on this interface and never on an engine. That matters here more than
 * it usually would: this deployment already runs two engines (Baileys and whatsapp-web.js)
 * behind `EngineRegistry`, and the agent must not become a third place that knows which one
 * is live.
 *
 * `OpenWaProvider` is the real implementation and is a *bridge*, not an engine — it delegates
 * to the existing `SessionService` and `MessageService`, so sessions, QR, reconnection,
 * media handling, the outbound queue, retries and duplicate protection all remain the ones
 * already in production. `MockWhatsAppProvider` implements the same interface in memory so
 * the whole agent flow can be exercised without a scanned account.
 */

import type { OutboundAttachment } from './agent-message.types';

/**
 * Connection states, as the brief specifies them.
 *
 * Derived from the engine's own status rather than tracked separately — a second state
 * machine would drift from the first, and the failure mode is a dashboard that says
 * CONNECTED while nothing sends.
 */
export type WhatsAppConnectionState =
  'DISCONNECTED' | 'QR_REQUIRED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR';

export interface WhatsAppStatus {
  sessionId: string;
  state: WhatsAppConnectionState;
  /** The connected account's own number, when the engine reports one. */
  connectedNumber: string | null;
  /** Present only while `QR_REQUIRED`. A data URL the dashboard renders. */
  qr: string | null;
  /** Engine-reported detail, for the status card. Never a stack trace. */
  detail: string | null;
  lastCheckedAt: string;
}

export interface SendTextInput {
  sessionId: string;
  chatId: string;
  text: string;
  quotedMessageId?: string;
}

export interface SendMediaInput {
  sessionId: string;
  chatId: string;
  attachment: OutboundAttachment;
  caption?: string;
}

export interface SendResult {
  /** The engine's message id, stored so delivery status can be joined to it later. */
  messageId: string;
  /** True when nothing was transmitted because the provider is a mock. */
  mock: boolean;
}

export interface WhatsAppProvider {
  /** Stable id for logs and the status card: `openwa` or `mock`. */
  readonly id: string;

  getStatus(sessionId: string): Promise<WhatsAppStatus>;
  listSessions(): Promise<string[]>;

  sendText(input: SendTextInput): Promise<SendResult>;
  sendDocument(input: SendMediaInput): Promise<SendResult>;
  sendImage(input: SendMediaInput): Promise<SendResult>;

  /**
   * Whether a number is reachable on WhatsApp.
   *
   * Checked before a first send rather than after a failure, because "that number is not on
   * WhatsApp" is something an operator can act on and a delivery failure three hours later
   * is not.
   */
  checkNumber(sessionId: string, phone: string): Promise<{ exists: boolean; chatId: string | null }>;
}

/** DI token, so the mock can be swapped in for tests and demos without touching callers. */
export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
