import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import {
  PLUGIN_MESSAGE_PORT,
  PLUGIN_SESSION_PORT,
  type PluginMessagePort,
  type PluginSessionPort,
} from '../../core/plugins/plugin-host-ports';
import { Session, SessionStatus } from '../../modules/session/entities/session.entity';
import type {
  SendMediaInput,
  SendResult,
  SendTextInput,
  WhatsAppConnectionState,
  WhatsAppProvider,
  WhatsAppStatus,
} from './whatsapp-provider.interface';

/**
 * The real transport: a bridge onto the gateway that is already running.
 *
 * Named for the product it lives in rather than for a library, because it does not own an
 * engine. Sessions, QR, reconnection, media, the outbound queue, retries and duplicate
 * protection remain the ones already in production behind `EngineRegistry`; this class only
 * translates between the agent's vocabulary and the services that do the work.
 *
 * **It reaches those services through `PLUGIN_MESSAGE_PORT`, resolved lazily via
 * `ModuleRef`, and reads sessions as a repository — never by importing SessionModule or
 * MessageModule.** That is not a stylistic choice. The command-center module's own header
 * records the rule: the dependency edge runs from SessionModule *into* the business layer,
 * so the projector can hold an optional recorder. An import in the other direction would
 * close a module cycle and Nest would refuse to start. The narrow port exists precisely so
 * code on this side can send without creating one.
 */
@Injectable()
export class OpenWaProvider implements WhatsAppProvider {
  readonly id = 'openwa';
  private readonly logger = createLogger('OpenWaProvider');
  private messagePort?: PluginMessagePort;
  private sessionPort?: PluginSessionPort;

  constructor(
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async getStatus(sessionId: string): Promise<WhatsAppStatus> {
    const session = await this.sessions.findOne({ where: { id: sessionId } });
    if (!session) {
      // Reported as an error state rather than thrown: the status card must always render,
      // and "ERROR — no such session" helps an operator more than a 500.
      return {
        sessionId,
        state: 'ERROR',
        connectedNumber: null,
        qr: null,
        detail: 'No session with that id.',
        lastCheckedAt: new Date().toISOString(),
      };
    }

    return {
      sessionId,
      state: toConnectionState(session.status),
      connectedNumber: session.phone ?? null,
      /*
       * The QR is not fetched here.
       *
       * It lives on the session record and the dashboard already renders it through its own
       * endpoint. Pulling it through this path as well would mean a second consumer asking
       * the engine to mint codes, and an unread code that rotates is worse than none.
       */
      qr: null,
      detail: describeStatus(session.status),
      lastCheckedAt: new Date().toISOString(),
    };
  }

  async listSessions(): Promise<string[]> {
    const rows = await this.sessions.find({ select: { id: true }, take: 100 });
    return rows.map(row => row.id);
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    const port = this.requirePort();
    const result = input.quotedMessageId
      ? await port.reply(input.sessionId, {
          chatId: input.chatId,
          quotedMessageId: input.quotedMessageId,
          text: input.text,
        })
      : await port.sendText(input.sessionId, { chatId: input.chatId, text: input.text });
    return { messageId: extractId(result), mock: false };
  }

  async sendDocument(input: SendMediaInput): Promise<SendResult> {
    const port = this.requirePort();
    const result = await port.sendDocument(input.sessionId, this.toMediaDto(input));
    return { messageId: extractId(result), mock: false };
  }

  async sendImage(input: SendMediaInput): Promise<SendResult> {
    const port = this.requirePort();
    const result = await port.sendImage(input.sessionId, this.toMediaDto(input));
    return { messageId: extractId(result), mock: false };
  }

  /**
   * Builds the media payload the send port expects.
   *
   * The port takes a URL. `MediaHandler.validateOutbound` has already refused anything that
   * is not a URL or base64, and refused filesystem paths outright — sending one would put an
   * internal server location into a customer's chat, or on a permissive host turn "send Ali
   * his statement" into an arbitrary file read.
   */
  private toMediaDto(input: SendMediaInput): { chatId: string; url?: string; caption?: string } {
    const isUrl = /^https?:\/\//i.test(input.attachment.data);
    if (!isUrl) {
      throw new Error('This transport sends documents by URL. Publish the file and pass its link.');
    }
    return {
      chatId: input.chatId,
      url: input.attachment.data,
      ...(input.caption ? { caption: input.caption } : {}),
    };
  }

  async checkNumber(sessionId: string, phone: string): Promise<{ exists: boolean; chatId: string | null }> {
    const digits = phone.replace(/\D/g, '');
    const session = this.resolveSessionPort();
    const engine = session?.getEngine(sessionId) as { checkNumberExists?: (n: string) => Promise<unknown> } | undefined;
    if (!engine?.checkNumberExists) {
      // Unknown is reported as unknown. A failed check must not read as a confirmed number.
      return { exists: false, chatId: null };
    }
    try {
      const result = (await engine.checkNumberExists(digits)) as
        { numberExists?: boolean; exists?: boolean; chatId?: string; jid?: string } | boolean | null;

      // The engines disagree on shape: one returns a boolean, the other an object.
      if (typeof result === 'boolean') return { exists: result, chatId: result ? `${digits}@c.us` : null };
      if (result && typeof result === 'object') {
        const exists = result.numberExists ?? result.exists;
        if (typeof exists === 'boolean') {
          return { exists, chatId: exists ? (result.chatId ?? result.jid ?? `${digits}@c.us`) : null };
        }
      }
    } catch (error) {
      this.logger.warn(`number check failed: ${(error as Error).message}`);
    }
    return { exists: false, chatId: null };
  }

  private requirePort(): PluginMessagePort {
    const port = this.resolveMessagePort();
    if (!port) throw new Error('The message transport is unavailable, so nothing was sent.');
    return port;
  }

  /** Resolved at call time, never at construction — that deferral is what breaks the cycle. */
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

  private resolveSessionPort(): PluginSessionPort | undefined {
    if (!this.sessionPort) {
      try {
        this.sessionPort = this.moduleRef?.get<typeof PLUGIN_SESSION_PORT, PluginSessionPort>(PLUGIN_SESSION_PORT, {
          strict: false,
        });
      } catch {
        return undefined;
      }
    }
    return this.sessionPort;
  }
}

/**
 * Maps the engine's session lifecycle onto the six states the brief names.
 *
 * Derived rather than tracked separately: a second state machine would drift from the
 * first, and what that produces is a dashboard reading CONNECTED while nothing sends.
 */
function toConnectionState(status: SessionStatus): WhatsAppConnectionState {
  switch (status) {
    case SessionStatus.READY:
      return 'CONNECTED';
    case SessionStatus.QR_READY:
      return 'QR_REQUIRED';
    case SessionStatus.CREATED:
    case SessionStatus.INITIALIZING:
    case SessionStatus.AUTHENTICATING:
      return 'CONNECTING';
    case SessionStatus.DISCONNECTED:
      // Not terminal — the lifecycle retries — so it reads as RECONNECTING, which is what
      // an operator watching the card actually wants to know.
      return 'RECONNECTING';
    case SessionStatus.FAILED:
    case SessionStatus.ACTION_REQUIRED:
      return 'ERROR';
    default:
      return 'DISCONNECTED';
  }
}

function describeStatus(status: SessionStatus): string {
  switch (status) {
    case SessionStatus.READY:
      return 'Connected and ready to send.';
    case SessionStatus.QR_READY:
      return 'Waiting for a QR scan.';
    case SessionStatus.ACTION_REQUIRED:
      return 'The session needs attention in the dashboard.';
    case SessionStatus.FAILED:
      return 'The session failed to start.';
    case SessionStatus.DISCONNECTED:
      return 'Disconnected — reconnecting.';
    default:
      return 'Starting up.';
  }
}

/** The send port returns a response DTO; the id is the part that matters downstream. */
function extractId(result: unknown): string {
  if (result && typeof result === 'object') {
    const row = result as Record<string, unknown>;
    for (const key of ['id', 'messageId', 'waMessageId']) {
      if (typeof row[key] === 'string') return row[key];
    }
  }
  return '';
}
