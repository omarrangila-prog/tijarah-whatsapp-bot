import { Injectable, Optional } from '@nestjs/common';
import { createLogger } from '../../../common/services/logger.service';
import { MockWhatsAppProvider } from '../../../integrations/whatsapp/mock.provider';

/**
 * The connection states §10 requires.
 *
 * `CONNECTED` is only ever reported when the engine itself says the session is open — never
 * inferred from a row in a table or from the fact that a send once worked. §11 is explicit
 * that the screen must not claim Connected otherwise, and the reason is practical: an
 * operator who believes the number is live stops watching the failures.
 */
export type WhatsAppSessionState =
  'DISCONNECTED' | 'QR_REQUIRED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'ERROR';

export interface DeliveryResult {
  messageId: string;
  /** True when the message was recorded rather than transmitted. Never silently dropped. */
  mock: boolean;
}

export interface SendDocumentInput {
  recipientWhatsAppNumber: string;
  fileDataOrPath: string;
  filename: string;
  caption?: string;
  mimeType?: string;
}

/**
 * Everything the job worker is allowed to ask of WhatsApp.
 *
 * This is the §10 `OpenWAProvider` surface. It is deliberately the ONLY route from a job to a
 * message: the worker never touches an engine, a session or a chat id directly, so the rules
 * about what may be sent live in one place rather than at every call site.
 *
 * The name in §10 is `OpenWAProvider`; the backing here is this project's own engine registry
 * (Baileys / whatsapp-web.js) rather than `@open-wa/wa-automate`, which is not a dependency
 * and needs a real Chrome. The interface is unchanged, so a wa-automate adapter is a drop-in.
 */
export interface WhatsAppDeliveryProvider {
  readonly id: string;
  connect(sessionId: string): Promise<WhatsAppSessionState>;
  getQRCode(sessionId: string): Promise<string | null>;
  getConnectionStatus(sessionId: string): Promise<WhatsAppSessionState>;
  validateNumber(sessionId: string, phone: string): Promise<{ exists: boolean; chatId: string | null }>;
  sendText(sessionId: string, to: string, text: string): Promise<DeliveryResult>;
  sendDocument(sessionId: string, input: SendDocumentInput): Promise<DeliveryResult>;
  getMessageStatus(sessionId: string, messageId: string): Promise<string | null>;
  /**
   * The number this session is signed in as, once it is connected.
   *
   * Used by the test send, which addresses the connected number itself. A self-addressed
   * test is the only one that is safe to fire on demand: any other recipient is a real
   * person who did not ask to be part of someone's connection check.
   */
  getConnectedNumber(sessionId: string): Promise<string | null>;
  reconnect(sessionId: string): Promise<WhatsAppSessionState>;
  logout(sessionId: string): Promise<void>;
}

export const WHATSAPP_DELIVERY_PROVIDER = Symbol('WHATSAPP_DELIVERY_PROVIDER');

/**
 * Digits only, country code included, no punctuation — the one comparison form.
 *
 * Returns null rather than a best guess for anything that cannot be a real number. A job with
 * an unusable recipient must fail at creation with a clear message, not at send time after a
 * document has already been fetched.
 */
export function normalizeWhatsAppNumber(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = String(input).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('00')) {
    // International access code: 0092300… is the same number as +92300….
    digits = digits.slice(2);
  } else if (digits.startsWith('0')) {
    /*
     * A national trunk prefix, and the case that matters most here.
     *
     * Tijarah Books stores contacts the way people write them locally — "03000000000". Simply
     * stripping the zero gave "3000000000", a number with no country code, and WhatsApp would
     * have delivered a customer's invoice to whoever that resolves to. The trunk zero is
     * replaced by the configured country code, which is what dialling it actually means.
     */
    digits = `${defaultCountryCode()}${digits.replace(/^0+/, '')}`;
  }

  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

/**
 * The country a bare national number belongs to.
 *
 * There is no way to infer this from the digits, and getting it wrong sends a customer's
 * invoice to a stranger abroad, so it is configuration rather than a guess in code.
 */
export function defaultCountryCode(): string {
  const configured = (process.env.WHATSAPP_DEFAULT_COUNTRY_CODE ?? '92').replace(/\D/g, '');
  return configured || '92';
}

export function toChatId(phoneE164: string): string {
  return `${phoneE164}@c.us`;
}

/**
 * The demonstration transport.
 *
 * Records instead of transmitting, and stamps every id `mock.` so a recorded send can never
 * be mistaken for a real one — in a log, on the jobs screen, or in the `whatsapp_message_id`
 * column. Used when `WHATSAPP_JOBS_MOCK=true`, and it is the default, so a fresh install
 * cannot message a customer by accident before anyone has chosen a number.
 */
@Injectable()
export class MockDeliveryProvider implements WhatsAppDeliveryProvider {
  readonly id = 'mock';
  private readonly logger = createLogger('MockDeliveryProvider');

  constructor(@Optional() private readonly transport?: MockWhatsAppProvider) {}

  private get engine(): MockWhatsAppProvider {
    return this.transport ?? (this.fallback ??= new MockWhatsAppProvider());
  }
  private fallback?: MockWhatsAppProvider;

  connect(): Promise<WhatsAppSessionState> {
    return Promise.resolve('CONNECTED');
  }
  getQRCode(): Promise<string | null> {
    // There is nothing to scan: a mock session is open by definition.
    return Promise.resolve(null);
  }
  getConnectionStatus(): Promise<WhatsAppSessionState> {
    return Promise.resolve('CONNECTED');
  }
  validateNumber(_sessionId: string, phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    const normalized = normalizeWhatsAppNumber(phone);
    return Promise.resolve({ exists: !!normalized, chatId: normalized ? toChatId(normalized) : null });
  }
  async sendText(sessionId: string, to: string, text: string): Promise<DeliveryResult> {
    const result = await this.engine.sendText({ sessionId, chatId: toChatId(to), text });
    return { messageId: result.messageId, mock: true };
  }
  async sendDocument(sessionId: string, input: SendDocumentInput): Promise<DeliveryResult> {
    const result = await this.engine.sendDocument({
      sessionId,
      chatId: toChatId(input.recipientWhatsAppNumber),
      attachment: {
        kind: 'document',
        data: input.fileDataOrPath,
        fileName: input.filename,
        mimeType: input.mimeType ?? 'application/pdf',
      },
      caption: input.caption,
    });
    this.logger.log(`recorded document ${input.filename} for ${input.recipientWhatsAppNumber} as ${result.messageId}`);
    return { messageId: result.messageId, mock: true };
  }
  getMessageStatus(): Promise<string | null> {
    return Promise.resolve('sent');
  }
  getConnectedNumber(): Promise<string | null> {
    // The mock transport's stand-in number; nothing is transmitted to it.
    return Promise.resolve('923470000000');
  }
  reconnect(): Promise<WhatsAppSessionState> {
    return Promise.resolve('CONNECTED');
  }
  logout(): Promise<void> {
    return Promise.resolve();
  }
}
