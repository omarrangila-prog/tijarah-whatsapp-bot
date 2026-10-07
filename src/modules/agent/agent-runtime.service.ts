import { Inject, Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../../common/services/logger.service';
import { AuthService } from '../auth/auth.service';
import { ApiKeyRole } from '../auth/entities/api-key.entity';
import { ToolRegistryService } from '../../core/agent-tools/tool-registry.service';
import { invokeTool } from '../../core/agent-tools/tool-invoker';
import type { AnyToolDescriptor } from '../../core/agent-tools/tool-descriptor';
import { AgentTurn } from './entities/agent-turn.entity';
import { ApprovalService } from './approval.service';
import { PermissionGuard } from '../../integrations/whatsapp/permission-guard';
import { scanForInjection, fenceUntrusted } from './injection-guard';
import { DraftService } from '../whatsapp-jobs/drafts/draft.service';
import { BotUserService } from '../whatsapp-jobs/tenancy/bot-user.service';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { bootstrapKeyFilePath } from '../auth/bootstrap-key-file';
import { writeSecretFile } from '../../common/utils/secret-file';
import {
  REASONING_PROVIDERS,
  supportsReasoning,
  type ReasoningMessage,
  type ReasoningProvider,
  type ReasoningTool,
  type ReasoningToolCall,
} from './agent-reasoning.interface';
import type {
  AgentActionRecord,
  AgentReply,
  NormalizedAgentMessage,
  SenderRole,
} from '../../integrations/whatsapp/agent-message.types';
import { buildSystemPrompt } from './agent-prompt';
import { advance, MENU_TRIGGER, rootMenu, stepFor, type MenuReport } from './client-menu';
import { toJsonSchema } from './zod-to-json-schema';

/**
 * The agent turn.
 *
 * This is the orchestrator the brief's §4 describes, and it is deliberately the *only* new
 * reasoning component: the tools are the registry's, the permissions are `AuthService`'s,
 * the model is the command-center provider seam's, and the transport is the existing
 * engine's. What did not exist before was the loop that connects them, because until now
 * the agent driving this registry lived outside the process and connected over MCP.
 *
 * The ordering below is the security design, and each step is there for a reason:
 *
 *   1. Approval commands are handled BEFORE the model sees anything. "APPROVE APR-1001" is
 *      an instruction to the system, not a question for a model, and routing it through one
 *      would let a model be talked into approving something.
 *   2. The sender's role is taken from the envelope, never inferred.
 *   3. The tool list is filtered by role before it is offered, so a tool a sender may not
 *      use is not merely refused — it is invisible.
 *   4. Every proposed call is re-checked by `PermissionGuard` and then executed through
 *      `invokeTool`, which applies the same auth the REST API applies.
 *   5. Nothing outbound happens inside the loop. A send becomes an approval row; the reply
 *      to the sender is the only message this turn produces.
 */

/** How many model round trips one turn may take before it is cut off. */
const MAX_STEPS = 4;

/**
 * What an approval command did, so the turn can be recorded truthfully.
 *
 * The reply is what the sender reads; the outcome is what the audit trail stores. They
 * differ on purpose — a refusal is a perfectly civil reply and a refused row.
 */
interface ApprovalCommandResult {
  reply: AgentReply;
  outcome: AgentTurn['outcome'];
  detail: string | null;
}

@Injectable()
export class AgentRuntime {
  private readonly logger = createLogger('AgentRuntime');

  private cachedRegistry?: ToolRegistryService;

  constructor(
    /**
     * Resolved at call time, not injected.
     *
     * `ToolRegistryService` comes from the global `AgentToolsModule`, which imports
     * SessionModule — and SessionModule imports THIS module so the projector can hold the
     * channel port, exactly as it holds the conversation recorder. Injecting the registry
     * here would close that loop and deadlock container construction (it did: the app hung
     * with every module's dependencies reported as initialised and no error). Deferring the
     * lookup is the same trick the plugin host ports use, for the same reason.
     */
    private readonly moduleRef: ModuleRef,
    private readonly authService: AuthService,
    private readonly approvals: ApprovalService,
    private readonly permissions: PermissionGuard,
    private readonly config: ConfigService,
    @InjectRepository(AgentTurn, 'data') private readonly turns: Repository<AgentTurn>,
    @Optional() @Inject(REASONING_PROVIDERS) private readonly providers: ReasoningProvider[] = [],
  ) {}

  /**
   * The service principal the agent acts as when it invokes a registry tool.
   *
   * One key for the agent rather than a key per phone number, because minting and rotating
   * a credential per WhatsApp contact is a key-management problem nobody would keep on top
   * of. The sender's own authority is enforced *above* this — `assertSenderMayUse` narrows
   * every call to what that sender's role permits — so the effective rights of any turn are
   * the intersection of the agent key and the sender's role, never the union.
   */
  private get agentKey(): string | null {
    const key = this.config.get<string>('agent.apiKey') ?? process.env.AGENT_API_KEY;
    return key && key.trim().length > 0 ? key.trim() : null;
  }

  private agentKeyCache: string | null = null;
  private agentKeyPending: Promise<string | null> | null = null;
  private warnedStaleAgentKey = false;

  /**
   * The key the agent acts as — and one it can always get.
   *
   * It used to be only `AGENT_API_KEY` from the environment, which an operator had to mint and
   * paste. On the first real deployment that failed twice: the database was rebuilt, the pasted
   * key stopped existing, and every client request came back "The tool failed: Invalid API key"
   * while the setting still looked filled in. Now: the configured key if it validates, else the
   * key this agent saved for itself, else a new OPERATOR key minted and saved owner-only beside
   * the bootstrap key. OPERATOR because no tool requires more, and the sender's own role still
   * narrows every call on top of it.
   *
   * `force` drops the cached key — used when a call is refused mid-run, e.g. after a pepper change.
   */
  private async resolveAgentKey(force = false): Promise<string | null> {
    if (force) this.agentKeyCache = null;
    if (this.agentKeyCache) return this.agentKeyCache;
    this.agentKeyPending ??= this.provisionAgentKey().finally(() => {
      this.agentKeyPending = null;
    });
    this.agentKeyCache = await this.agentKeyPending;
    return this.agentKeyCache;
  }

  private async provisionAgentKey(): Promise<string | null> {
    const configured = this.agentKey;
    if (configured && (await this.keyIsValid(configured))) return configured;
    if (configured && !this.warnedStaleAgentKey) {
      this.warnedStaleAgentKey = true;
      this.logger.warn('AGENT_API_KEY is set but no longer valid — using a self-provisioned agent key instead');
    }

    const file = join(dirname(bootstrapKeyFilePath()), '.agent-key');
    const saved = existsSync(file) ? readFileSync(file, 'utf-8').trim() : '';
    if (saved && (await this.keyIsValid(saved))) return saved;

    try {
      const { rawKey } = await this.authService.createApiKey({
        name: 'WhatsApp agent (self-provisioned)',
        role: ApiKeyRole.OPERATOR,
      });
      try {
        writeSecretFile(file, rawKey);
      } catch (error) {
        // Unsaved, the key still works for this process; the next restart mints another.
        this.logger.warn(`could not save the agent key: ${(error as Error).message}`);
      }
      this.logger.log('minted a new agent API key (OPERATOR) for tool calls');
      return rawKey;
    } catch (error) {
      this.logger.error(`could not provision an agent API key: ${(error as Error).message}`);
      return null;
    }
  }

  private async keyIsValid(rawKey: string): Promise<boolean> {
    try {
      await this.authService.validateApiKey(rawKey);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether this number is part-way through composing a document.
   *
   * Absent when the drafts module is not loaded, which keeps the agent usable without it.
   */
  /** Whether this number is mapped to a company in `bot_users`. Resolved lazily, like the drafts. */
  /**
   * Whether this number may be served, settling "which business?" on the way if it can.
   *
   * A number on more than one Tijarah account is asked to choose, and the answer is read
   * from the very next message — by name or by position — so the exchange is two turns, not
   * a form. The choice list is not stored: it is fetched again on the reply, which is one
   * more host call and no state that can go stale.
   */
  private async registrationGate(
    message: NormalizedAgentMessage,
  ): Promise<{ ok: true } | { ok: false; reply: string | null; reason: string }> {
    const businessName = process.env.WHATSAPP_BUSINESS_NAME?.replace(/^"|"$/g, '') || 'the bot';
    const contact = process.env.BOT_REGISTRATION_CONTACT?.trim();
    let users: BotUserService;
    try {
      users = this.moduleRef.get(BotUserService, { strict: false });
    } catch {
      return {
        ok: false,
        reply: `This number is not registered with ${businessName} yet.`,
        reason: 'Registry unavailable',
      };
    }

    const outcome = await users.lookup(message.senderPhone);
    if (outcome.kind === 'registered') return { ok: true };

    if (outcome.kind === 'ambiguous') {
      const chosen = message.text?.trim()
        ? await users.choose(message.senderPhone, message.text, outcome.choices)
        : null;
      if (chosen) {
        return {
          ok: false,
          reply: `Linked to *${chosen.displayName ?? 'your business'}*. What would you like — a ledger, a report, or a new document?`,
          reason: 'Business chosen',
        };
      }
      const list = outcome.choices
        .map((c, i) => `${i + 1}. ${c.businessName?.trim() || `Account ${c.sid}`}`)
        .join('\n');
      return {
        ok: false,
        reply: `This number is on more than one ${businessName} account. Which business do you mean?\n${list}\n\nReply with the name or the number.`,
        reason: 'Business not yet chosen',
      };
    }

    /*
     * Not a client: silence, unless the deployment asks for the registration notice.
     *
     * The bot runs on the business's own number, so most people who message it are not clients
     * at all — prospects asking how digital invoicing works, suppliers, friends. Telling them
     * "this number is not registered" answered a question nobody asked, and on the first live day
     * it drew angry replies. They are now left to the team in the inbox, which is where a human
     * conversation belongs. BOT_REGISTRATION_REPLY=true restores the notice for a deployment on a
     * dedicated bot number, where only would-be clients ever write.
     */
    if (process.env.BOT_REGISTRATION_REPLY !== 'true') {
      return { ok: false, reply: null, reason: 'Not a registered client' };
    }
    return {
      ok: false,
      reply:
        `This number is not registered with ${businessName} yet. ` +
        (contact
          ? `Please message from the number on your ${businessName} profile, or contact ${contact} to get set up.`
          : `Please message from the number on your ${businessName} profile, or ask your administrator to add it.`),
      reason: 'Not a registered bot user',
    };
  }

  private async hasOpenDraft(senderPhone: string): Promise<boolean> {
    return (await this.openDraftSummary(senderPhone)) !== null;
  }

  /**
   * What the person is part-way through composing, for the system prompt.
   *
   * A model has no memory between messages. Told only "From Meezan Bank" it answered "I cannot
   * help with this" — a perfectly reasonable reply to a message with no context, and a useless
   * one to somebody answering the question the bot had just asked. Stating the open draft and
   * what it still needs turns the fragment back into an answer.
   */
  private async openDraftSummary(senderPhone: string): Promise<string | null> {
    try {
      const drafts = this.moduleRef.get(DraftService, { strict: false });
      const draft = await drafts.openDraftFor(senderPhone);
      if (!draft) return null;
      const review = drafts.review(draft);
      const filled = (review.details as Array<{ label: string; value: string }>)
        .map(d => `${d.label}: ${d.value}`)
        .join(', ');
      const missingLabel = typeof review.missing === 'string' ? review.missing : null;
      const missing = missingLabel ? `Still needed: ${missingLabel}.` : 'It is complete and ready to submit.';
      return `${draft.displayName} ${draft.reference} is in progress (${filled || 'nothing filled yet'}). ${missing}`;
    } catch {
      return null;
    }
  }

  /**
   * The last few exchanges with this person, so the model can follow a conversation.
   *
   * Each turn is fenced exactly as the current message is: earlier messages are no more
   * trusted for being older. Capped, because a long history is a long prompt and the useful
   * context is nearly always the last two or three exchanges.
   */
  private async recentHistory(message: NormalizedAgentMessage, nonce: string): Promise<ReasoningMessage[]> {
    const rows = await this.turns.find({
      where: { senderPhone: message.senderPhone },
      order: { createdAt: 'DESC' },
      take: 6,
    });
    const cutoff = Date.now() - 2 * 60 * 60 * 1000;
    const history: ReasoningMessage[] = [];
    for (const row of rows.reverse()) {
      if (new Date(row.createdAt).getTime() < cutoff) continue;
      if (row.inboundMessageId === message.messageId) continue;
      if (!row.inboundText) continue;
      history.push({ role: 'user', content: fenceUntrusted(row.inboundText, nonce) });
      if (row.replyText) history.push({ role: 'assistant', content: row.replyText });
    }
    return history;
  }

  /**
   * The menu's answer to this message, or null to let the reasoning handle it.
   *
   * The step is read from the last thing the bot said to this number, so no session is kept
   * and a restart mid-menu cannot strand anyone. A chosen report is queued through the same
   * tool a typed request uses, so there is one path to a document and one set of permissions.
   */
  private async menuReply(message: NormalizedAgentMessage): Promise<string | null> {
    const text = message.text?.trim() ?? '';
    const reports = await this.menuReports();
    if (reports.length === 0) return null;

    if (MENU_TRIGGER.test(text)) return rootMenu();

    const last = await this.turns.findOne({
      where: { senderPhone: message.senderPhone },
      order: { createdAt: 'DESC' },
    });
    const action = advance(stepFor(last?.replyText ?? null), text, reports);

    if (action.kind === 'none') return null;
    if (action.kind === 'show') return action.text;
    if (action.kind === 'document') return action.prompt;

    /*
     * Queued through the same gate a typed request goes through, not around it. The menu is a
     * way of choosing, never a second route to a document: the permission layer, the
     * sender pinning and the audit record are all the ordinary ones.
     */
    const outcome = await this.executeCall(
      {
        // `menu.` marks the origin in the audit trail, as `sim.` does for simulated turns.
        id: `menu.${Date.now()}`,
        name: 'RequestAccountingReport',
        input: {
          documentType: action.documentType,
          ...(action.from ? { from: action.from } : {}),
          ...(action.to ? { to: action.to } : {}),
        },
      },
      message,
      this.toolsFor(message.senderRole, false),
    );

    const name = reports.find(r => r.documentType === action.documentType)?.displayName ?? 'Your report';
    if (outcome.isError || outcome.record.decision === 'denied') {
      return `${name} could not be prepared. ${outcome.record.reason ?? 'Please try again in a moment.'}`;
    }
    /*
     * Nothing on success: the PDF is the answer.
     *
     * The document arrives with a caption naming the report and its period, so a message
     * before it only adds a notification for something that has not happened yet — and if
     * the fetch fails, the worker says so itself. One message per document, and it is the
     * document. An empty string is the runtime's "send nothing".
     */
    return '';
  }

  /**
   * The reports the menu offers.
   *
   * Read through the agent's own `ListAccountingReports` tool rather than by reaching for
   * WhatsAppJobsService: the agent module does not import the jobs module, so resolving the
   * service turned into an empty list and the menu silently switched itself off — a boot-time
   * shape no unit test sees. The tool is already in the registry, already permission-checked,
   * and returns exactly this list.
   */
  private async menuReports(): Promise<MenuReport[]> {
    const tool = this.registry.list().find(t => t.name === 'ListAccountingReports');
    if (!tool) return [];
    try {
      const key = await this.resolveAgentKey(false);
      if (!key) return [];
      const result = (await this.invokeWithKeyRecovery(tool, {}, key)) as {
        reports?: Array<{ documentType: string; name: string; optionalParameters?: string[] }>;
      };
      return (result.reports ?? []).map(row => ({
        documentType: row.documentType,
        displayName: row.name,
        datedByDefault: (row.optionalParameters ?? []).includes('from'),
      }));
    } catch (error) {
      this.logger.warn(`menu could not list reports: ${describeToolError(error)}`);
      return [];
    }
  }

  private get registry(): ToolRegistryService {
    this.cachedRegistry ??= this.moduleRef.get(ToolRegistryService, { strict: false });
    return this.cachedRegistry;
  }

  private pickProvider(): ReasoningProvider | null {
    return this.availableProviders()[0] ?? null;
  }

  /** Every configured provider that could host a turn, most preferred first. */
  private availableProviders(): ReasoningProvider[] {
    return (this.providers ?? []).filter(supportsReasoning).filter(provider => provider.isAvailable());
  }

  /**
   * Asks the preferred provider, and falls through to the next when it cannot answer.
   *
   * A model being unavailable is not the same as a model refusing: a free tier that has run
   * out of credit, a rate limit, a transient 5xx. Before this, any of those reached the
   * sender as "Something went wrong handling that" and the channel was effectively down until
   * somebody topped up an account. The rule-based provider is last in the list precisely so
   * there is always something that can answer, and this is what actually reaches it.
   *
   * A provider that fails is logged with the reason, because "the bot got quieter" is not a
   * symptom anyone can act on.
   */
  /** Per provider: when it last answered, and the last error it gave. */
  private readonly providerHealth = new Map<
    string,
    { lastOkAt: string | null; lastError: string | null; lastErrorAt: string | null }
  >();

  private noteProvider(id: string, error: Error | null): void {
    const health = this.providerHealth.get(id) ?? { lastOkAt: null, lastError: null, lastErrorAt: null };
    if (error) {
      health.lastError = error.message.slice(0, 300);
      health.lastErrorAt = new Date().toISOString();
    } else {
      health.lastOkAt = new Date().toISOString();
    }
    this.providerHealth.set(id, health);
  }

  /**
   * Which reasoners exist, which are configured, and how each last fared.
   *
   * Without this, a dead key was invisible from outside: every reply quietly came from the
   * rule-based fallback and the only trace was a warning in the container log. Errors are the
   * providers' own messages, which never contain a key — keys travel in headers.
   */
  reasoningStatus(): Array<{
    id: string;
    model: string | null;
    available: boolean;
    lastOkAt: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
  }> {
    return this.providers.map(provider => ({
      id: provider.id,
      model: provider.model ?? null,
      available: provider.isAvailable(),
      ...(this.providerHealth.get(provider.id) ?? { lastOkAt: null, lastError: null, lastErrorAt: null }),
    }));
  }

  private async reasonWithFallback(
    request: Parameters<ReasoningProvider['reason']>[0],
  ): Promise<{ response: Awaited<ReturnType<ReasoningProvider['reason']>>; provider: ReasoningProvider }> {
    const candidates = this.availableProviders();
    let lastError: Error | null = null;

    for (const provider of candidates) {
      try {
        const response = await provider.reason(request);
        this.noteProvider(provider.id, null);
        return { response, provider };
      } catch (error) {
        lastError = error as Error;
        this.noteProvider(provider.id, lastError);
        this.logger.warn(
          `reasoning provider "${provider.id}" failed, trying the next: ${lastError.message.slice(0, 180)}`,
        );
      }
    }
    throw lastError ?? new Error('No reasoning provider is available.');
  }

  async handle(message: NormalizedAgentMessage): Promise<AgentReply> {
    const startedAt = Date.now();

    /*
     * Duplicate protection, in the database.
     *
     * Engines redeliver on reconnect. A unique index on the inbound message id means the
     * second delivery loses the insert race rather than producing a second reply — which
     * for a customer would be the agent answering twice, and for an admin could be a second
     * approval request for one action.
     */
    const existing = await this.turns.findOne({ where: { inboundMessageId: message.messageId } });
    if (existing) {
      return silent('Already processed.');
    }

    const settings = await this.permissions.loadSettings();
    const scan = scanForInjection(message.text);

    const record = this.turns.create({
      channel: message.channel,
      inboundMessageId: message.messageId,
      conversationId: message.conversationId,
      senderPhone: message.senderPhone,
      senderRole: message.senderRole,
      inboundText: message.text,
      injectionFlag: scan.flagged ? scan.findings.map(f => f.code).join(',') : null,
      outcome: 'ok',
      // Stamped when the turn starts, so the log reads in the order the conversation happened
      // rather than in order of how long each turn took to finish. durationMs covers the rest.
      createdAt: new Date(),
    });

    try {
      /* --- group messages are out of scope; answering one leaks to everyone in it --- */
      if (message.isGroup) {
        return await this.finish(record, silent('Group message ignored.'), 'ignored', 'Group chat', startedAt);
      }

      /* --- 1. approval commands, before any model --- */
      const command = ApprovalService.parseCommand(message.text);
      if (command.kind !== 'none') {
        /*
         * The stop switch outranks an approval.
         *
         * Approval commands are handled before the model precisely so a model cannot be
         * talked into approving something — but that ordering originally let APPROVE walk
         * straight past the halt, which made the emergency stop ineffective against exactly
         * the actions it most needs to stop: ones already prepared and one word from being
         * sent. Cancelling and editing are still allowed while halted, because neither
         * sends anything and an operator should be able to clear the queue during an
         * incident.
         */
        if (settings.automationHalted && command.kind === 'approve') {
          const reply = plain(
            `Automation is stopped${settings.haltedReason ? ` (${settings.haltedReason})` : ''}, so ${command.reference} was not sent. Resume automation first.`,
          );
          return await this.finish(record, reply, 'halted', `approval blocked: ${command.reference}`, startedAt);
        }
        const handled = await this.handleApprovalCommand(command, message);
        /*
         * A refused approval is recorded as refused.
         *
         * This used to record 'ok' for every approval command, because the turn itself had
         * been handled without error. That made the audit trail read as though a rejected
         * self-approval had gone through — the one row where the distinction matters most.
         */
        return await this.finish(
          record,
          handled.reply,
          handled.outcome,
          `approval:${command.kind}${handled.detail ? ` ${handled.detail}` : ''}`,
          startedAt,
        );
      }

      /* --- 2. the stop switch --- */
      if (settings.automationHalted) {
        // Still recorded, still answered — a halt stops actions, not acknowledgement.
        const reply = plain(
          message.senderRole === 'admin'
            ? `Automation is currently stopped${settings.haltedReason ? ` (${settings.haltedReason})` : ''}. I can still answer questions, but I will not send anything until it is resumed.`
            : 'Thanks — someone will get back to you shortly.',
        );
        return await this.finish(record, reply, 'halted', settings.haltedReason, startedAt);
      }

      /*
       * --- 3. registration, for a deployment that serves a host system's clients ---
       *
       * Before the unknown-sender policy, on purpose. A Tijarah client messaging for the first
       * time is not in the CRM and not on the admin list, so the contact mapper calls them
       * "unknown" — and the ignore policy would drop them silently, before anyone had asked
       * whether their number is on a Tijarah account. So the registry is consulted first: a
       * mapped number becomes a `client` for the rest of the turn, with its own tools and its
       * own persona; a number on two accounts is asked which; anyone else is told how to get
       * registered — and told, rather than ignored, because to them silence reads as a dead
       * number, not as a policy.
       *
       * Opt-in, because the receivables deployment genuinely does serve unregistered customers.
       */
      if (
        process.env.BOT_REQUIRE_REGISTRATION === 'true' &&
        message.senderRole !== 'admin' &&
        message.senderRole !== 'staff'
      ) {
        const gate = await this.registrationGate(message);
        if (!gate.ok) {
          if (gate.reply === null) {
            // Recorded for the audit trail, answered by nobody: the team picks it up in the inbox.
            return await this.finish(record, silent('Not a registered client.'), 'ignored', gate.reason, startedAt);
          }
          const outcome = gate.reason === 'Business chosen' ? 'ok' : 'refused';
          return await this.finish(record, plain(gate.reply), outcome, gate.reason, startedAt);
        }
        message = { ...message, senderRole: 'client' };
        record.senderRole = 'client';
      }

      /* --- 3b. unknown senders --- */
      if (message.senderRole === 'unknown') {
        if (settings.unknownSenderPolicy === 'ignore') {
          return await this.finish(record, silent('Unknown sender ignored.'), 'ignored', 'Unknown sender', startedAt);
        }
        const reply = plain(
          settings.unknownSenderMessage ??
            'Thanks for your message. This number is monitored by our team and someone will reply shortly.',
        );
        return await this.finish(record, reply, 'ok', 'Unknown sender welcomed', startedAt);
      }

      /*
       * --- 3c. media without text ---
       *
       * A voice note or a photo reaches the bot as a message with no words. The two real
       * messages received before this existed were exactly that, and the bot answered them
       * with a menu of things it could do — to someone who had said nothing it could read.
       * Saying what it can and cannot take is the only useful reply.
       */
      if (!message.text?.trim() && message.messageType !== 'text') {
        const reply = plain(
          `I can only read text messages, not ${message.messageType === 'audio' ? 'voice notes' : message.messageType === 'image' ? 'photos' : 'attachments'}. ` +
            'Please type what you need — for example: "send me the customer ledger for C-1005".',
        );
        return await this.finish(record, reply, 'ok', `Unreadable ${message.messageType}`, startedAt);
      }

      /*
       * --- 3d. the numbered menu ---
       *
       * Clients only, and only once the gate above has confirmed one. Free text still goes to
       * the reasoning: the menu answers a number, or a greeting, and otherwise returns `none`
       * and falls through. That order matters — "send me invoice 179" must not be read as
       * menu option 179 just because a menu happens to be open.
       *
       * It exists because free text only works while a language model is answering. The live
       * log has "trial balance send" delivering a PDF and "Send me trail balance" — one letter
       * different — getting the help list, because the AI key was missing and the rule-based
       * fallback matches fixed phrasings only. A number cannot be misspelled.
       */
      if (message.senderRole === 'client' && message.text?.trim()) {
        /*
         * `null` means the menu did not handle this — fall through to the reasoning. An empty
         * string means it DID handle it and has nothing to say, which is the queued-document
         * case: the PDF is the reply. The two must stay distinct, or a silent success would
         * be re-answered by the model as if nothing had happened.
         */
        const menu = await this.menuReply(message);
        if (menu !== null) {
          return menu === ''
            ? await this.finish(record, silent('Document queued; the document is the reply.'), 'ok', 'Menu', startedAt)
            : await this.finish(record, plain(menu), 'ok', 'Menu', startedAt);
        }
      }

      /* --- 4. rate limiting --- */
      if (await this.permissions.isRateLimited(message.senderPhone)) {
        const reply = plain('You have sent a lot of messages in a short time. Please try again a little later.');
        return await this.finish(record, reply, 'rate_limited', 'Per-sender hourly cap', startedAt);
      }

      /* --- 5. the loop --- */
      const reply = await this.runReasoning(message, scan.restrictTools, record);
      return await this.finish(record, reply, record.outcome, record.outcomeDetail, startedAt);
    } catch (error) {
      const detail = (error as Error).message;
      this.logger.error(`agent turn failed: ${detail}`);
      const reply = plain(
        message.senderRole === 'admin'
          ? `Something went wrong handling that: ${detail.slice(0, 200)}`
          : 'Sorry — something went wrong. Someone will follow up.',
      );
      return await this.finish(record, reply, 'error', detail, startedAt);
    }
  }

  /* ------------------------------------------------------------ reasoning */

  private async runReasoning(
    message: NormalizedAgentMessage,
    restrictTools: boolean,
    record: AgentTurn,
  ): Promise<AgentReply> {
    const provider = this.pickProvider();
    if (!provider) {
      record.outcome = 'error';
      record.outcomeDetail = 'No reasoning provider is available.';
      return plain('The assistant is not configured yet. Please ask an administrator to finish setup.');
    }
    record.providerId = provider.id;
    record.model = provider.model;

    const offered = this.toolsFor(message.senderRole, restrictTools);
    const nonce = randomUUID().replace(/-/g, '').slice(0, 10);

    const history: ReasoningMessage[] = [
      ...(await this.recentHistory(message, nonce)),
      {
        role: 'user',
        // The sender's words are fenced as data. The trusted framing lives in the system
        // prompt, which never contains anything the sender wrote.
        content: fenceUntrusted(message.text || `[${message.messageType} with no caption]`, nonce),
      },
    ];
    const draftSummary = await this.openDraftSummary(message.senderPhone);

    const actions: AgentActionRecord[] = [];
    let pendingApprovalId: string | null = null;
    let usedProvider: ReasoningProvider = provider;
    let finalText = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for (let step = 0; step < MAX_STEPS; step += 1) {
      const { response, provider: answered } = await this.reasonWithFallback({
        system: buildSystemPrompt({
          senderRole: message.senderRole,
          senderName: message.senderName,
          nonce,
          restricted: restrictTools,
          openDraft: draftSummary,
        }),
        messages: history,
        tools: offered.map(toReasoningTool),
        context: {
          senderRole: message.senderRole,
          // Resolved lazily: DraftService lives in the jobs module, and eager injection here
          // would pull that graph into this constructor.
          hasOpenDraft: await this.hasOpenDraft(message.senderPhone),
        },
      });

      // Recorded from whichever provider actually answered, not the one first preferred.
      usedProvider = answered;
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;
      if (response.text) finalText = response.text;

      if (response.toolCalls.length === 0 || response.finished) break;

      history.push({ role: 'assistant', content: response.text, toolCalls: response.toolCalls });

      for (const call of response.toolCalls) {
        const outcome = await this.executeCall(call, message, offered);
        actions.push(outcome.record);
        if (outcome.approvalId) pendingApprovalId = outcome.approvalId;
        history.push({
          role: 'tool',
          toolCallId: call.id,
          content: outcome.content,
          isError: outcome.isError,
        });
      }
    }

    record.actions = actions;
    // Whichever provider actually answered, which may not be the one first preferred: a model
    // out of credit falls through, and the audit trail should say what really did the work.
    record.providerId = usedProvider.id;
    record.model = usedProvider.model;
    record.inputTokens = inputTokens;
    record.outputTokens = outputTokens;

    /*
     * A queued document is answered by the document, not by a sentence.
     *
     * The tools that queue one deliberately return no text, and "Done." was the generic
     * stand-in filling that silence — so a person asking for a ledger got "Done." and then,
     * moments later, the PDF. One message per document, and it is the document. Anything
     * else with nothing to say still falls back, because silence there would look broken.
     */
    const queuedADocument = actions.some(a => a.tool === 'RequestAccountingReport' && a.decision === 'allowed');
    const text = finalText || (queuedADocument ? '' : 'Done.');

    return {
      text,
      attachments: [],
      actions,
      pendingApprovalId,
      shouldReply: text !== '',
    };
  }

  /**
   * Runs one proposed tool call through the gate and, if permitted, the registry.
   *
   * A denied call is not an error — it is an outcome the model is told about, so it can
   * explain the refusal to the sender rather than retrying it. An approval-required call
   * becomes a row and the model is told an approval was raised.
   */
  private async executeCall(
    call: ReasoningToolCall,
    message: NormalizedAgentMessage,
    offered: AnyToolDescriptor[],
  ): Promise<{ record: AgentActionRecord; content: string; isError: boolean; approvalId: string | null }> {
    const started = Date.now();
    const tool = offered.find(t => t.name === call.name);

    if (!tool) {
      // Either a hallucinated name or one this sender was not offered. Same answer either way.
      return {
        record: { tool: call.name, decision: 'denied', reason: 'Unknown or unavailable tool.' },
        content: `No such tool is available: ${call.name}`,
        isError: true,
        approvalId: null,
      };
    }

    /*
     * Pin the session BEFORE the permission check, not just before execution.
     *
     * Session-scoped tools must run against the session the message arrived on, never one
     * the model named. That pinning used to happen only on the direct-invoke path, so an
     * approval stored the model's raw input — and executing it later failed with
     * "sessionId is required for this tool", after the admin had already approved it. The
     * approval must carry exactly what will run.
     */
    let pinnedInput = tool.sessionScoped ? { ...call.input, sessionId: message.sessionId } : call.input;
    // Same reasoning as the session pin, for identity: see ToolDescriptor.senderScoped.
    if (tool.senderScoped) pinnedInput = { ...pinnedInput, senderPhone: message.senderPhone };

    const recipientPhone = extractRecipient(call.input);
    const verdict = await this.permissions.evaluate({
      toolName: tool.name,
      senderRole: message.senderRole,
      senderPhone: message.senderPhone,
      // A property of the tool, not a claim by the caller: the runtime pinned the sender above.
      selfAddressed: tool.senderScoped === true,
      recipientPhone,
      targetContactId: null,
      isWrite: tool.tier === 'write',
    });

    if (verdict.decision === 'denied') {
      return {
        record: { tool: tool.name, decision: 'denied', reason: verdict.reason },
        content: `Refused: ${verdict.reason}`,
        isError: false,
        approvalId: null,
      };
    }

    if (verdict.decision === 'requires_approval') {
      const approval = await this.approvals.create({
        toolName: tool.name,
        toolInput: pinnedInput,
        summary: renderApprovalSummary(tool.name, call.input, message),
        requestedByPhone: message.senderPhone,
        recipientPhone,
        conversationId: message.conversationId,
      });
      return {
        record: {
          tool: tool.name,
          decision: 'requires_approval',
          reason: verdict.reason,
          approvalId: approval.reference,
        },
        content: JSON.stringify({
          status: 'awaiting_approval',
          approvalReference: approval.reference,
          reason: verdict.reason,
          summary: approval.summary,
          expiresAt: approval.expiresAt.toISOString(),
        }),
        isError: false,
        approvalId: approval.reference,
      };
    }

    return this.invokeAllowed(tool, pinnedInput, message, started);
  }

  /**
   * One call, retried once with a re-provisioned key if the key itself was refused.
   *
   * Only a key refusal is retried — a tool that fails on its own merits must not run twice.
   */
  private async invokeWithKeyRecovery(
    tool: AnyToolDescriptor,
    input: Record<string, unknown>,
    rawKey: string,
  ): Promise<unknown> {
    try {
      return await invokeTool(tool, input, rawKey, this.authService);
    } catch (error) {
      if (!/invalid api key/i.test(describeToolError(error))) throw error;
      const fresh = await this.resolveAgentKey(true);
      if (!fresh || fresh === rawKey) throw error;
      return invokeTool(tool, input, fresh, this.authService);
    }
  }

  /** Executes a permitted call through the registry's own invoker. */
  private async invokeAllowed(
    tool: AnyToolDescriptor,
    input: Record<string, unknown>,
    message: NormalizedAgentMessage,
    started: number,
  ): Promise<{ record: AgentActionRecord; content: string; isError: boolean; approvalId: null }> {
    const rawKey = await this.resolveAgentKey();
    if (!rawKey) {
      return {
        record: { tool: tool.name, decision: 'denied', reason: 'No agent API key is configured.' },
        content: 'The assistant has no API key configured, so it cannot run that.',
        isError: true,
        approvalId: null,
      };
    }

    try {
      const result = await this.invokeWithKeyRecovery(tool, input, rawKey);
      return {
        record: { tool: tool.name, decision: 'allowed', reason: null, ok: true, durationMs: Date.now() - started },
        content: JSON.stringify(result ?? { ok: true }).slice(0, 8000),
        isError: false,
        approvalId: null,
      };
    } catch (error) {
      const detail = describeToolError(error);
      return {
        record: {
          tool: tool.name,
          decision: 'allowed',
          reason: null,
          ok: false,
          errorMessage: detail.slice(0, 300),
          durationMs: Date.now() - started,
        },
        content: `The tool failed: ${detail.slice(0, 300)}`,
        isError: true,
        approvalId: null,
      };
    }
  }

  /**
   * The tools a sender is offered.
   *
   * Filtered rather than merely gated: a tool a sender cannot use is not in the list the
   * model receives, so the model does not propose it, the sender does not see a refusal,
   * and there is no surface to argue with.
   */
  private toolsFor(senderRole: SenderRole, restrictTools: boolean): AnyToolDescriptor[] {
    const effectiveRole = PermissionGuard.apiRoleFor(senderRole);
    const isCustomer = senderRole === 'customer' || senderRole === 'unknown';
    return this.registry.list().filter(tool => {
      // The customer and client fences, applied to the offer and not only to the verdict.
      if (isCustomer && !PermissionGuard.isCustomerAllowed(tool.name)) return false;
      if (senderRole === 'client' && !PermissionGuard.isClientAllowed(tool.name)) return false;
      if (restrictTools && tool.tier === 'write') return false;
      if (!tool.requiredRole) return true;
      return roleRank(effectiveRole) >= roleRank(tool.requiredRole);
    });
  }

  /* ------------------------------------------------------------ approvals */

  /**
   * What an approval command did, so the turn can be recorded truthfully.
   *
   * The reply is what the sender reads; the outcome is what the audit trail stores. They
   * differ on purpose — a refusal is a perfectly civil reply and a refused row.
   */

  private async handleApprovalCommand(
    command: Exclude<ReturnType<typeof ApprovalService.parseCommand>, { kind: 'none' }>,
    message: NormalizedAgentMessage,
  ): Promise<ApprovalCommandResult> {
    if (message.senderRole !== 'admin' && message.senderRole !== 'staff') {
      return {
        reply: plain('Only an authorised number can decide a prepared action.'),
        outcome: 'refused',
        detail: 'sender is not authorised',
      };
    }

    if (command.kind === 'cancel') {
      const result = await this.approvals.reject(command.reference, message.senderPhone);
      return {
        reply: plain(result.message),
        outcome: result.ok ? 'ok' : 'refused',
        detail: result.ok ? null : 'not cancellable',
      };
    }

    if (command.kind === 'edit') {
      if (!command.newText) {
        return {
          reply: plain(
            `Send the new wording after the reference, for example: EDIT ${command.reference} Dear Ali, ...`,
          ),
          outcome: 'ok',
          detail: 'wording not supplied',
        };
      }
      const approval = await this.approvals.findByReference(command.reference);
      if (!approval || approval.state !== 'pending') {
        return {
          reply: plain(`${command.reference} is not waiting for a decision.`),
          outcome: 'refused',
          detail: 'not pending',
        };
      }
      /*
       * Editing replaces the prepared text and leaves the action pending.
       *
       * It does not approve as a side effect. An edit is a change of mind about the
       * wording; sending still needs a deliberate APPROVE, so nobody sends a message by
       * correcting a typo in it.
       */
      const edited = { ...approval.toolInput, message: command.newText, text: command.newText };
      await this.approvals.create({
        toolName: approval.toolName,
        toolInput: edited,
        summary: approval.summary.replace(/Message:[\s\S]*$/, `Message: ${command.newText}`),
        requestedByPhone: approval.requestedByPhone,
        recipientPhone: approval.recipientPhone,
        recipientLabel: approval.recipientLabel,
        verifiedContext: approval.verifiedContext,
        conversationId: approval.conversationId,
      });
      await this.approvals.reject(command.reference, message.senderPhone);
      const replacement = await this.approvals.listPending(1);
      return {
        reply: plain(
          `Updated. ${command.reference} was cancelled and replaced by ${replacement[0]?.reference ?? 'a new request'} with your wording. Reply APPROVE ${replacement[0]?.reference ?? ''} to send it.`.trim(),
        ),
        outcome: 'ok',
        detail: null,
      };
    }

    const grant = await this.approvals.approve(command.reference, message.senderPhone, message.senderRole);
    // Self-approval, an expired reference, one already used, one that never existed: all refusals.
    if (!grant.ok || !grant.approval)
      return { reply: plain(grant.message), outcome: 'refused', detail: grant.message.slice(0, 180) };

    const executed = await this.executeApproved(grant.approval.id, grant.approval.toolName, grant.approval.toolInput);
    return { reply: plain(executed), outcome: 'ok', detail: grant.approval.toolName };
  }

  /**
   * Runs an approved action.
   *
   * Separate from the loop on purpose: this runs with no model in the path at all. What was
   * approved is what executes, byte for byte, so nothing can be re-drafted between the
   * approval and the send.
   */
  async executeApproved(approvalId: string, toolName: string, toolInput: Record<string, unknown>): Promise<string> {
    const tool = this.registry.get(toolName);
    const rawKey = await this.resolveAgentKey();
    /*
     * Approved actions are not all sends.
     *
     * The confirmation used to be a flat "Sent." for everything that went through here,
     * which meant approving a payment — the one action where an administrator most needs to
     * know precisely what just happened to the books — was reported as though a message had
     * gone out. The wording follows what the tool actually did.
     */
    const isSend = toolName.startsWith('MessageSend') || toolName.startsWith('MessageReply');
    const failedVerb = isSend ? 'send' : 'run';
    if (!tool || !rawKey) {
      await this.approvals.markFailed(approvalId, 'Tool or agent key unavailable at execution time.');
      return `That could not be ${failedVerb === 'send' ? 'sent' : 'run'} — the assistant is missing configuration. Nothing happened.`;
    }
    try {
      const result = (await invokeTool(tool, toolInput, rawKey, this.authService)) as { id?: string } | null;
      const messageId = result && typeof result === 'object' && 'id' in result ? String(result.id) : null;
      await this.approvals.markExecuted(approvalId, messageId);
      return isSend ? 'Sent.' : `Done — ${describeExecuted(toolName, result)}`;
    } catch (error) {
      const detail = (error as Error).message;
      await this.approvals.markFailed(approvalId, detail);
      return `That failed to ${failedVerb}: ${detail.slice(0, 200)}`;
    }
  }

  /* -------------------------------------------------------------- storage */

  private async finish(
    record: AgentTurn,
    reply: AgentReply,
    outcome: AgentTurn['outcome'],
    detail: string | null | undefined,
    startedAt: number,
  ): Promise<AgentReply> {
    record.replyText = reply.shouldReply ? reply.text : null;
    record.outcome = outcome;
    record.outcomeDetail = detail ? String(detail).slice(0, 500) : null;
    record.durationMs = Date.now() - startedAt;
    try {
      await this.turns.save(record);
    } catch (error) {
      // A duplicate key here means a concurrent delivery of the same message won the race.
      // The other turn is handling it; this one goes quiet rather than replying twice.
      this.logger.warn(`could not record agent turn: ${(error as Error).message}`);
      return silent('Duplicate delivery.');
    }
    return reply;
  }
}

/* ------------------------------------------------------------------ helpers */

function plain(text: string): AgentReply {
  return { text, attachments: [], actions: [], pendingApprovalId: null, shouldReply: true };
}

function silent(reason: string): AgentReply {
  return { text: reason, attachments: [], actions: [], pendingApprovalId: null, shouldReply: false };
}

function roleRank(role: ApiKeyRole): number {
  return role === ApiKeyRole.ADMIN ? 3 : role === ApiKeyRole.OPERATOR ? 2 : 1;
}

function toReasoningTool(tool: AnyToolDescriptor): ReasoningTool {
  return { name: tool.name, description: tool.description, inputSchema: toJsonSchema(tool.inputSchema) };
}

/** Pulls the recipient out of whichever field a tool uses for it. */
function extractRecipient(input: Record<string, unknown>): string | null {
  for (const key of ['recipient_phone', 'recipientPhone', 'phone', 'chatId', 'to']) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/** The text an approver reads. Built once, from the values that will actually execute. */
function renderApprovalSummary(
  toolName: string,
  input: Record<string, unknown>,
  message: NormalizedAgentMessage,
): string {
  const lines = [`Action: ${toolName}`, `Requested by: ${message.senderPhone}`];
  const recipient = extractRecipient(input);
  if (recipient) lines.push(`Recipient: ${recipient}`);
  const body = input.message ?? input.text ?? input.caption;
  if (typeof body === 'string') lines.push(`Message: ${body}`);
  const file = input.fileName ?? input.filename;
  if (typeof file === 'string') lines.push(`Attachment: ${file}`);
  return lines.join('\n');
}

/**
 * A one-line account of an approved non-send action, for the administrator who released it.
 *
 * Names the record the accounting system created where it gave one back, because "done" on
 * its own is not something anyone can reconcile against a bank statement later.
 */
function describeExecuted(toolName: string, result: { id?: string } | null): string {
  const id = result && typeof result === 'object' && 'id' in result && result.id ? String(result.id) : null;
  switch (toolName) {
    case 'LedgerRecordPayment':
      return `the payment is recorded in the accounting system${id ? ` (${id})` : ''}.`;
    case 'LedgerCreateInvoice':
      return `the invoice is raised in the accounting system${id ? ` (${id})` : ''}.`;
    default:
      return `${toolName} completed${id ? ` (${id})` : ''}.`;
  }
}

/**
 * The actual reason a tool call failed, not the exception's headline.
 *
 * The invoker reports a validation failure as a BadRequestException carrying the field-level
 * issues — "items.0.qty: Expected string, received number". Nest keeps that list in the
 * response body and sets `.message` to the generic "Bad Request Exception", which is what the
 * model was being shown. It could not correct a mistake it was not told about, and the person
 * saw "the tool returned a bad request error" with nothing they could act on either.
 */
function describeToolError(error: unknown): string {
  const response = (error as { getResponse?: () => unknown }).getResponse?.();
  if (response && typeof response === 'object') {
    const message = (response as { message?: unknown }).message;
    if (Array.isArray(message)) return message.map(String).join('; ');
    if (typeof message === 'string') return message;
  }
  return (error as Error).message ?? 'Unknown error';
}
