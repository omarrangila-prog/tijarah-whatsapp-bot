import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../common/services/logger.service';
import { WHATSAPP_PROVIDER, type WhatsAppProvider, type WhatsAppStatus } from './whatsapp-provider.interface';

/**
 * Which session the agent speaks through, and whether it can speak at all.
 *
 * This deployment runs several WhatsApp sessions. The agent must answer on the session a
 * message arrived on — replying to a customer from a different number is confusing at best
 * and, if the other number belongs to a different part of the business, a disclosure.
 *
 * So inbound turns always carry their own `sessionId` and this class is not consulted. It
 * exists for the other direction: agent-initiated work (a scheduled event, a daily summary)
 * has no arriving message to inherit a session from, and needs a deliberate answer to
 * "which number does this go out as?"
 */
@Injectable()
export class SessionManager {
  private readonly logger = createLogger('AgentSessionManager');
  private cached: { at: number; status: WhatsAppStatus } | null = null;

  constructor(
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
    private readonly config: ConfigService,
  ) {}

  /**
   * The session agent-initiated messages go out on.
   *
   * Configured explicitly rather than inferred. Picking "the first connected session"
   * would mean the number a customer hears from changes when sessions restart in a
   * different order, which is exactly the kind of thing nobody notices until a customer
   * asks who just messaged them.
   */
  get outboundSessionId(): string | null {
    return this.config.get<string>('agent.sessionId') ?? process.env.AGENT_SESSION_ID ?? null;
  }

  /** Cached briefly: the status card polls, and each call reaches the engine. */
  async status(sessionId?: string): Promise<WhatsAppStatus | null> {
    const id = sessionId ?? this.outboundSessionId;
    if (!id) return null;
    if (!sessionId && this.cached && Date.now() - this.cached.at < 5_000) return this.cached.status;

    const status = await this.provider.getStatus(id);
    if (!sessionId) this.cached = { at: Date.now(), status };
    return status;
  }

  /** Whether an agent-initiated send can happen right now. */
  async canSend(): Promise<{ ok: boolean; reason: string | null }> {
    const id = this.outboundSessionId;
    if (!id) {
      return { ok: false, reason: 'No outbound session is configured (set AGENT_SESSION_ID).' };
    }
    const status = await this.status();
    if (!status) return { ok: false, reason: 'The configured session could not be read.' };
    if (status.state !== 'CONNECTED') {
      return { ok: false, reason: `WhatsApp is ${status.state.toLowerCase().replace('_', ' ')}.` };
    }
    return { ok: true, reason: null };
  }

  async listSessions(): Promise<string[]> {
    return this.provider.listSessions();
  }
}
