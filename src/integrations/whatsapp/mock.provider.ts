import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  SendMediaInput,
  SendResult,
  SendTextInput,
  WhatsAppConnectionState,
  WhatsAppProvider,
  WhatsAppStatus,
} from './whatsapp-provider.interface';

export interface MockSentMessage {
  kind: 'text' | 'document' | 'image';
  sessionId: string;
  chatId: string;
  body: string;
  fileName?: string;
  messageId: string;
  at: string;
}

/**
 * An in-memory WhatsApp, so the whole agent can be demonstrated and tested without scanning
 * a real account (brief §15).
 *
 * It is a genuine implementation of the transport, not a no-op: sends are recorded, ids are
 * returned, connection state can be driven through every value including the failure ones,
 * and `inject()` feeds a message in as though it had arrived. That is what makes it possible
 * to test disconnection, reconnection and duplicate delivery — none of which can be
 * rehearsed against a live account.
 *
 * Every id it mints is prefixed `mock.`, and `SendResult.mock` is true. Nothing downstream
 * can mistake a mock send for a real one, which is the property that makes it safe to run a
 * demo against production data.
 */
@Injectable()
export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly id = 'mock';

  /** Everything "sent", newest last. Assertions read this. */
  readonly sent: MockSentMessage[] = [];

  private state: WhatsAppConnectionState = 'CONNECTED';
  private connectedNumber: string | null = '923470000000';
  private qr: string | null = null;
  private detail: string | null = null;
  /** Numbers that should report as not on WhatsApp. */
  private readonly missing = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async getStatus(sessionId: string): Promise<WhatsAppStatus> {
    return {
      sessionId,
      state: this.state,
      connectedNumber: this.state === 'CONNECTED' ? this.connectedNumber : null,
      qr: this.state === 'QR_REQUIRED' ? (this.qr ?? 'data:image/png;base64,mock-qr') : null,
      detail: this.detail,
      lastCheckedAt: new Date().toISOString(),
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listSessions(): Promise<string[]> {
    return ['mock-session'];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendText(input: SendTextInput): Promise<SendResult> {
    return this.record('text', input.sessionId, input.chatId, input.text);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendDocument(input: SendMediaInput): Promise<SendResult> {
    return this.record('document', input.sessionId, input.chatId, input.caption ?? '', input.attachment.fileName);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendImage(input: SendMediaInput): Promise<SendResult> {
    return this.record('image', input.sessionId, input.chatId, input.caption ?? '', input.attachment.fileName);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async checkNumber(_sessionId: string, phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    const digits = phone.replace(/\D/g, '');
    if (this.missing.has(digits)) return { exists: false, chatId: null };
    return { exists: true, chatId: `${digits}@c.us` };
  }

  /**
   * A send fails when the transport is not connected.
   *
   * Mirroring the real failure rather than always succeeding is the point: a test that only
   * ever sees a healthy transport never exercises the retry and approval-failure paths,
   * which are the ones that matter when something is wrong at 2am.
   */
  private record(
    kind: MockSentMessage['kind'],
    sessionId: string,
    chatId: string,
    body: string,
    fileName?: string,
  ): SendResult {
    if (this.state !== 'CONNECTED') {
      throw new Error(`WhatsApp is ${this.state.toLowerCase()}; nothing was sent.`);
    }
    const messageId = `mock.${randomUUID()}`;
    this.sent.push({ kind, sessionId, chatId, body, fileName, messageId, at: new Date().toISOString() });
    return { messageId, mock: true };
  }

  /* ------------------------------------------------------- test controls */

  setState(state: WhatsAppConnectionState, detail?: string): void {
    this.state = state;
    this.detail = detail ?? null;
    if (state === 'QR_REQUIRED') this.qr = 'data:image/png;base64,mock-qr';
  }

  markNumberMissing(phone: string): void {
    this.missing.add(phone.replace(/\D/g, ''));
  }

  reset(): void {
    this.sent.length = 0;
    this.state = 'CONNECTED';
    this.detail = null;
    this.missing.clear();
  }

  lastSent(): MockSentMessage | undefined {
    return this.sent[this.sent.length - 1];
  }
}
