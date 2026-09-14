import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { createLogger } from '../../../common/services/logger.service';
import { SessionService } from '../../session/session.service';
import { SessionStatus } from '../../session/entities/session.entity';
import { MessageService } from '../../message/message.service';
import { ContactService } from '../../contact/contact.service';
import type { SendMediaMessageDto } from '../../message/dto/send-message.dto';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { Message } from '../../message/entities/message.entity';
import {
  normalizeWhatsAppNumber,
  toChatId,
  type DeliveryResult,
  type SendDocumentInput,
  type WhatsAppDeliveryProvider,
  type WhatsAppSessionState,
} from './whatsapp-delivery.provider';

/**
 * The real transport: this project's WhatsApp engines, behind the §10 interface.
 *
 * It goes through `SessionService` and `MessageService` rather than reaching for an engine
 * directly, so a job-driven send takes exactly the same path as one from the dashboard — the
 * same sending gate, the same persisted message row, the same delivery receipts. A second
 * path would mean a second set of rules to keep in agreement, and they would drift.
 *
 * Services are resolved lazily through `ModuleRef` for the reason documented on the agent
 * tools: eager injection pulls the message and session graphs into this module's constructor
 * and re-creates the `events.gateway` ↔ `auth.service` cycle the repo already carries.
 */
@Injectable()
export class EngineDeliveryProvider implements WhatsAppDeliveryProvider {
  readonly id = 'engine';
  private readonly logger = createLogger('EngineDeliveryProvider');

  constructor(private readonly moduleRef: ModuleRef) {}

  private get sessions(): SessionService {
    return this.moduleRef.get(SessionService, { strict: false });
  }
  private get messages(): MessageService {
    return this.moduleRef.get(MessageService, { strict: false });
  }
  private get contacts(): ContactService {
    return this.moduleRef.get(ContactService, { strict: false });
  }

  /**
   * Maps the engine's own vocabulary onto the six states §10 names.
   *
   * Anything unrecognised becomes ERROR rather than CONNECTED. Guessing optimistically here
   * is what produces a screen that says Connected while every send fails.
   */
  private toState(raw: string | null | undefined): WhatsAppSessionState {
    // Mapped from SessionStatus in session.entity.ts, exhaustively. The first version of this
    // was written from memory and did not include `qr_ready` — the status Baileys actually
    // reports while showing a code — so a session waiting to be scanned was reported as ERROR.
    switch (raw) {
      case SessionStatus.READY:
        return 'CONNECTED';
      case SessionStatus.QR_READY:
        return 'QR_REQUIRED';
      case SessionStatus.CREATED:
      case SessionStatus.INITIALIZING:
      case SessionStatus.AUTHENTICATING:
        return 'CONNECTING';
      case SessionStatus.DISCONNECTED:
        return 'DISCONNECTED';
      case SessionStatus.ACTION_REQUIRED:
      case SessionStatus.FAILED:
        return 'ERROR';
      default:
        /*
         * An unrecognised status is ERROR, never CONNECTED.
         *
         * §11 forbids showing Connected unless the client confirms an active session, and the
         * practical reason is that an operator who believes the number is live stops watching
         * the failures. Guessing optimistically here is how that screen starts lying.
         */
        return 'ERROR';
    }
  }

  /**
   * Resolves `WHATSAPP_JOBS_SESSION_ID` to a real session id, accepting a name too.
   *
   * `findOne` takes a uuid, but an operator setting this in an env file naturally writes the
   * name they gave the session — and the failure mode was silent and misleading: the lookup
   * threw, the state came back ERROR, and the screen reported a broken WhatsApp connection
   * when the connection was fine and only the config was being read too literally.
   *
   * Cached after the first successful resolution, since the mapping does not change while the
   * process is running.
   */
  private async resolveSessionId(idOrName: string): Promise<string | null> {
    if (this.resolvedSessionIds.has(idOrName)) return this.resolvedSessionIds.get(idOrName) ?? null;
    try {
      await this.sessions.findOne(idOrName);
      this.resolvedSessionIds.set(idOrName, idOrName);
      return idOrName;
    } catch {
      // Not an id. Fall through to a name lookup rather than reporting the session missing.
    }
    try {
      const all = (await this.sessions.findAll()) as Array<{ id: string; name?: string }>;
      const match = all.find(session => session.name === idOrName);
      if (match) {
        this.resolvedSessionIds.set(idOrName, match.id);
        return match.id;
      }
    } catch (error) {
      this.logger.warn(`could not list sessions: ${(error as Error).message}`);
    }
    return null;
  }

  private readonly resolvedSessionIds = new Map<string, string>();

  private async statusOf(sessionId: string): Promise<WhatsAppSessionState> {
    try {
      const resolved = await this.resolveSessionId(sessionId);
      if (!resolved) {
        this.logger.warn(`no WhatsApp session named or identified by "${sessionId}"`);
        return 'DISCONNECTED';
      }
      const session = (await this.sessions.findOne(resolved)) as { status?: string } | null;
      return this.toState(session?.status);
    } catch (error) {
      this.logger.warn(`could not read session ${sessionId}: ${(error as Error).message}`);
      return 'ERROR';
    }
  }

  async connect(sessionId: string): Promise<WhatsAppSessionState> {
    const resolved = (await this.resolveSessionId(sessionId)) ?? sessionId;
    await this.sessions.start(resolved);
    return this.statusOf(sessionId);
  }

  async getQRCode(sessionId: string): Promise<string | null> {
    try {
      const resolved = (await this.resolveSessionId(sessionId)) ?? sessionId;
      const { qrCode } = await this.sessions.getQRCode(resolved);
      return qrCode || null;
    } catch {
      // Not started, or already past the QR stage. Neither is an error worth raising here:
      // the screen asks for a code and gets "there isn't one", which is the truthful answer.
      return null;
    }
  }

  getConnectionStatus(sessionId: string): Promise<WhatsAppSessionState> {
    return this.statusOf(sessionId);
  }

  async validateNumber(sessionId: string, phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    const normalized = normalizeWhatsAppNumber(phone);
    if (!normalized) return { exists: false, chatId: null };
    try {
      const resolved = (await this.resolveSessionId(sessionId)) ?? sessionId;
      const checked = (await this.contacts.checkNumberExists(resolved, normalized)) as
        { exists?: boolean; numberExists?: boolean; chatId?: string | null } | boolean;
      const exists = typeof checked === 'boolean' ? checked : (checked.exists ?? checked.numberExists);
      if (typeof exists === 'boolean') {
        const chatId = typeof checked === 'object' ? (checked.chatId ?? null) : null;
        return { exists, chatId: chatId ?? toChatId(normalized) };
      }
    } catch (error) {
      this.logger.warn(`number check unavailable, accepting shape only: ${(error as Error).message}`);
    }
    /*
     * The engine could not answer. The number is well-formed, so the job proceeds and a real
     * failure surfaces at send time with the engine's own error — which is better than
     * refusing a valid delivery because a check was unavailable.
     */
    return { exists: true, chatId: toChatId(normalized) };
  }

  async sendText(sessionId: string, to: string, text: string): Promise<DeliveryResult> {
    const normalized = normalizeWhatsAppNumber(to);
    if (!normalized) throw new Error('Recipient number is not a valid WhatsApp number');
    const resolved = (await this.resolveSessionId(sessionId)) ?? sessionId;
    const result = await this.messages.sendText(resolved, { chatId: toChatId(normalized), text });
    return { messageId: result.messageId, mock: false };
  }

  /**
   * Sends the document through the same DTO the REST controller uses.
   *
   * The payload is `base64` + `mimetype`, not a `media` field — and the gateway answers with
   * `messageId`, not `id`. Both were wrong here behind an `as never` cast, which compiled
   * happily and would have failed at the one moment that matters: the first real send to a
   * customer. The cast is gone, so the compiler now checks this against the DTO.
   */
  async sendDocument(sessionId: string, input: SendDocumentInput): Promise<DeliveryResult> {
    const normalized = normalizeWhatsAppNumber(input.recipientWhatsAppNumber);
    if (!normalized) throw new Error('Recipient number is not a valid WhatsApp number');
    const dto: SendMediaMessageDto = {
      chatId: toChatId(normalized),
      base64: input.fileDataOrPath,
      mimetype: input.mimeType ?? 'application/pdf',
      filename: input.filename,
      caption: input.caption,
    };
    const resolved = (await this.resolveSessionId(sessionId)) ?? sessionId;
    const result = await this.messages.sendDocument(resolved, dto);
    return { messageId: result.messageId, mock: false };
  }

  /**
   * The delivery state of one message, looked up by its WhatsApp id.
   *
   * Queried straight from the message repository rather than through `getMessages`, whose
   * options have no message-id filter — passing one there was silently ignored and returned
   * whatever message happened to be most recent, reporting a stranger's delivery state as
   * this document's. A wrong answer here is worse than none.
   */
  async getMessageStatus(sessionId: string, messageId: string): Promise<string | null> {
    try {
      const row = await this.moduleRef
        .get<Repository<Message>>(getRepositoryToken(Message, 'data'), { strict: false })
        .findOne({
          where: { sessionId: (await this.resolveSessionId(sessionId)) ?? sessionId, waMessageId: messageId },
        });
      return row?.status ?? null;
    } catch {
      return null;
    }
  }

  async getConnectedNumber(sessionId: string): Promise<string | null> {
    try {
      const resolved = await this.resolveSessionId(sessionId);
      if (!resolved) return null;
      const session = (await this.sessions.findOne(resolved)) as { phone?: string | null; status?: string } | null;
      // Only when the engine says the session is live; a stale phone on a dead session is
      // exactly the kind of thing that makes a test send go somewhere unexpected.
      if (this.toState(session?.status) !== 'CONNECTED') return null;
      return normalizeWhatsAppNumber(session?.phone ?? null);
    } catch {
      return null;
    }
  }

  /**
   * Stop, then start. There is no single `restart` on SessionService, and doing it in two
   * steps is honest about what happens: the session really does go down before it comes back,
   * and anything in flight during that window fails rather than queueing invisibly.
   */
  async reconnect(sessionId: string): Promise<WhatsAppSessionState> {
    const resolved = (await this.resolveSessionId(sessionId)) ?? sessionId;
    await this.sessions.stop(resolved).catch(() => undefined);
    await this.sessions.start(resolved);
    return this.statusOf(sessionId);
  }

  async logout(sessionId: string): Promise<void> {
    const resolved = (await this.resolveSessionId(sessionId)) ?? sessionId;
    await this.sessions.logout(resolved);
  }
}
