import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { createLogger } from '../../common/services/logger.service';
import { sessionScopeVisible } from '../../common/security/session-scope';
import { PLUGIN_MESSAGE_PORT, type PluginMessagePort } from '../../core/plugins/plugin-host-ports';
import { AutomationFlow, FlowTrigger, type FlowAction } from './entities/automation-flow.entity';
import { AutomationExecution } from './entities/automation-execution.entity';
import { Conversation, ConversationPriority, ConversationStatus } from './entities/conversation.entity';
import { ConversationTag } from './entities/conversation-tag.entity';
import { Tag } from './entities/tag.entity';
import { ConversationService } from './conversation.service';
import { TagService } from './tag.service';
import { FollowUpService } from './follow-up.service';
import { QuickReplyService } from './quick-reply.service';
import { DEFAULT_BUSINESS_HOURS, evaluateConditions, parseClock, type BusinessHours } from './flow-evaluator';
import { interpolate, phoneFromWaId } from './conversation-state';

/** The inbound message as the flow engine sees it. */
export interface FlowMessage {
  chatId: string;
  body?: string | null;
  type?: string;
  kind?: string;
  chatName?: string | null;
  timestamp?: number;
  fromMe?: boolean;
}

/**
 * Messages older than this never trigger a flow.
 *
 * A reconnect replays the offline queue through the same inbound path. Without this gate, coming
 * back online after an outage would fire every rule against every backlogged message at once —
 * which is both a burst of sends and the unbounded arm of an automation-answers-automation loop.
 * Mirrors the existing autoreply evaluator's gate deliberately: two engines, one policy.
 */
const MAX_MESSAGE_AGE_SECONDS = 300;

/** Above this many tracked cooldowns, sweep the expired ones before adding another. */
const COOLDOWN_SWEEP_THRESHOLD = 10_000;

/**
 * The WHEN → IF → THEN engine.
 *
 * Runs on the projector's at-most-once inbound dispatch, after the existing autoreply rules, and is
 * fail-open in exactly the same way: every failure is caught, logged to the execution table, and
 * swallowed. A broken flow degrades to "that flow did not run" — never to a dropped message.
 *
 * Three independent guards bound automation traffic:
 *  1. the freshness gate above;
 *  2. a per-(flow, conversation) cooldown, entered BEFORE the actions run so a burst collapses to
 *     one execution even while the first is still in flight;
 *  3. a loop guard that refuses to act on a chat this process has just sent an automated message
 *     into, which is what stops two gateways answering each other.
 */
@Injectable()
export class AutomationFlowService {
  private readonly logger = createLogger('AutomationFlowService');

  /** `${flowId}:${conversationId}` → epoch ms the flow stays quiet until. Per-process, like the autoreply map. */
  private readonly cooldowns = new Map<string, number>();
  /** `${sessionId}:${chatId}` → epoch ms until automated sends into that chat are refused. */
  private readonly recentAutomatedSends = new Map<string, number>();

  private messagePort?: PluginMessagePort;

  constructor(
    @InjectRepository(AutomationFlow, 'data') private readonly flows: Repository<AutomationFlow>,
    @InjectRepository(AutomationExecution, 'data') private readonly executions: Repository<AutomationExecution>,
    @InjectRepository(ConversationTag, 'data') private readonly conversationTags: Repository<ConversationTag>,
    @InjectRepository(Tag, 'data') private readonly tags: Repository<Tag>,
    private readonly conversations: ConversationService,
    private readonly tagService: TagService,
    private readonly followUps: FollowUpService,
    private readonly quickReplies: QuickReplyService,
    @Optional() private readonly moduleRef?: ModuleRef,
    @Optional() private readonly config?: ConfigService,
  ) {}

  // ------------------------------------------------------------------- CRUD

  /**
   * List flows, optionally narrowed to one number and always confined to the calling key's scope.
   *
   * A flow with a NULL `sessionId` applies to every number, so it is deliberately hidden from a
   * session-restricted key: showing it would reveal a rule acting on numbers that key cannot see.
   * Mirrors `sessionScopeVisible`, which makes the same call for integration instances.
   */
  async list(sessionId?: string, allowedSessions?: string[] | null): Promise<AutomationFlow[]> {
    const flows = await this.flows.find({
      where: sessionId ? [{ sessionId }, { sessionId: IsNull() }] : {},
      order: { createdAt: 'DESC' },
    });
    return flows.filter(flow => sessionScopeVisible(allowedSessions, flow.sessionId));
  }

  async get(id: string): Promise<AutomationFlow> {
    const flow = await this.flows.findOne({ where: { id } });
    if (!flow) throw new NotFoundException(`Automation flow ${id} not found`);
    return flow;
  }

  create(input: Partial<AutomationFlow>): Promise<AutomationFlow> {
    return this.flows.save(
      this.flows.create({
        name: input.name!,
        description: input.description ?? null,
        sessionId: input.sessionId ?? null,
        trigger: input.trigger ?? FlowTrigger.MESSAGE_RECEIVED,
        triggerAfterMinutes: input.triggerAfterMinutes ?? null,
        conditions: input.conditions ?? [],
        actions: input.actions ?? [],
        enabled: input.enabled ?? true,
        cooldownSeconds: input.cooldownSeconds ?? 300,
      }),
    );
  }

  async update(id: string, input: Partial<AutomationFlow>): Promise<AutomationFlow> {
    const flow = await this.get(id);
    // Assigned field by field rather than through a keyed loop: a loop needs an index-signature
    // cast, which would also let a typo'd or unrelated key through into the row.
    if (input.name !== undefined) flow.name = input.name;
    if (input.description !== undefined) flow.description = input.description;
    if (input.sessionId !== undefined) flow.sessionId = input.sessionId;
    if (input.trigger !== undefined) flow.trigger = input.trigger;
    if (input.triggerAfterMinutes !== undefined) flow.triggerAfterMinutes = input.triggerAfterMinutes;
    if (input.conditions !== undefined) flow.conditions = input.conditions;
    if (input.actions !== undefined) flow.actions = input.actions;
    if (input.enabled !== undefined) flow.enabled = input.enabled;
    if (input.cooldownSeconds !== undefined) flow.cooldownSeconds = input.cooldownSeconds;
    return this.flows.save(flow);
  }

  async remove(id: string): Promise<void> {
    await this.get(id);
    await this.flows.delete({ id });
  }

  /** Execution log, filtered to the sessions the calling key may see. */
  async listExecutions(
    filters: { flowId?: string; limit?: number } = {},
    allowedSessions?: string[] | null,
  ): Promise<AutomationExecution[]> {
    const rows = await this.executions.find({
      where: filters.flowId ? { flowId: filters.flowId } : {},
      order: { createdAt: 'DESC' },
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    });
    if (allowedSessions == null || allowedSessions.length === 0) return rows;
    return rows.filter(row => row.sessionId != null && allowedSessions.includes(row.sessionId));
  }

  // -------------------------------------------------------------- evaluation

  /**
   * Evaluate every enabled flow against one inbound message.
   *
   * Unlike the autoreply rules, ALL matching flows run — they perform different actions (tag,
   * assign, prioritise) and stopping at the first match would make a tagging rule silently disable
   * a routing rule. Only the send action is loop-guarded, since that is the one with an outside
   * effect.
   */
  async evaluateInbound(sessionId: string, message: FlowMessage): Promise<void> {
    if (message.fromMe === true) return;
    if (!message.chatId) return;
    const timestamp = typeof message.timestamp === 'number' ? message.timestamp : null;
    if (timestamp !== null && Date.now() / 1000 - timestamp > MAX_MESSAGE_AGE_SECONDS) return;

    let flows: AutomationFlow[];
    try {
      flows = await this.flows.find({
        where: [
          { enabled: true, trigger: FlowTrigger.MESSAGE_RECEIVED, sessionId },
          { enabled: true, trigger: FlowTrigger.MESSAGE_RECEIVED, sessionId: undefined },
        ],
        order: { createdAt: 'ASC' },
      });
    } catch (error) {
      this.logger.warn('Automation flow lookup failed', { sessionId, error: String(error) });
      return;
    }
    if (flows.length === 0) return;

    const conversation = await this.conversations.findByChat(sessionId, message.chatId);
    if (!conversation) return;
    const tagNames = await this.tagNamesFor(conversation.id);

    for (const flow of flows) {
      await this.runFlow(flow, conversation, {
        body: message.body ?? '',
        sessionId,
        chatKind: message.kind ?? conversation.kind ?? 'individual',
        contactTags: tagNames,
        conversationStatus: conversation.status,
        conversationPriority: conversation.priority,
        now: new Date(),
        businessHours: this.businessHours(),
      });
    }
  }

  /** Run one flow: conditions, guards, then actions. Never throws. */
  private async runFlow(
    flow: AutomationFlow,
    conversation: Conversation,
    context: Parameters<typeof evaluateConditions>[1],
  ): Promise<void> {
    try {
      if (!evaluateConditions(flow.conditions, context)) {
        // Skips are recorded too: "why did my rule not fire" is the question the log has to answer.
        await this.record(flow, conversation, 'skipped', 'conditions_unmet');
        return;
      }
      if (this.inCooldown(flow.id, conversation.id)) {
        await this.record(flow, conversation, 'skipped', 'cooldown');
        return;
      }
      this.enterCooldown(flow, conversation.id);

      const results: Array<{ type: string; ok: boolean; detail?: string }> = [];
      for (const action of flow.actions ?? []) {
        results.push(await this.runAction(action, flow, conversation, context.body));
      }
      await this.record(flow, conversation, 'matched', null, results);
      await this.flows.increment({ id: flow.id }, 'executionCount', 1);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn('Automation flow failed', { flowId: flow.id, error: detail });
      await this.record(flow, conversation, 'failed', detail.slice(0, 240));
    }
  }

  /** Execute a single action. Returns its result rather than throwing, so one bad step logs and the rest still run. */
  private async runAction(
    action: FlowAction,
    flow: AutomationFlow,
    conversation: Conversation,
    incomingBody: string,
  ): Promise<{ type: string; ok: boolean; detail?: string }> {
    try {
      switch (action.type) {
        case 'send_reply': {
          const key = `${conversation.sessionId}:${conversation.chatId}`;
          if ((this.recentAutomatedSends.get(key) ?? 0) > Date.now()) {
            return {
              type: action.type,
              ok: false,
              detail: 'loop_guard: an automated reply was just sent to this chat',
            };
          }
          const text = await this.resolveReplyText(action, conversation);
          if (!text.trim()) return { type: action.type, ok: false, detail: 'empty reply text' };
          const port = this.resolveMessagePort();
          if (!port) return { type: action.type, ok: false, detail: 'message port unavailable' };
          this.markAutomatedSend(key, flow.cooldownSeconds);
          await port.sendText(conversation.sessionId, { chatId: conversation.chatId, text });
          return { type: action.type, ok: true };
        }
        case 'add_tag': {
          const tag = await this.tagService.ensureByName(action.value ?? '');
          await this.conversations.addTag(conversation.id, tag.id);
          return { type: action.type, ok: true, detail: tag.name };
        }
        case 'remove_tag': {
          const tag = await this.tags.findOne({ where: { name: (action.value ?? '').trim() } });
          if (!tag) return { type: action.type, ok: false, detail: 'tag not found' };
          await this.conversations.removeTag(conversation.id, tag.id);
          return { type: action.type, ok: true, detail: tag.name };
        }
        case 'assign_agent':
          await this.conversations.assign(conversation.id, { agentId: action.value ?? null }, `flow:${flow.name}`);
          return { type: action.type, ok: true };
        case 'assign_team':
          await this.conversations.assign(conversation.id, { teamId: action.value ?? null }, `flow:${flow.name}`);
          return { type: action.type, ok: true };
        case 'set_priority':
          await this.conversations.setPriority(conversation.id, asPriority(action.value));
          return { type: action.type, ok: true, detail: action.value };
        case 'set_status':
          await this.conversations.setStatus(conversation.id, asStatus(action.value));
          return { type: action.type, ok: true, detail: action.value };
        case 'create_follow_up': {
          const dueAt = new Date(Date.now() + Math.max(action.dueInMinutes ?? 60, 1) * 60_000);
          await this.followUps.create({
            conversationId: conversation.id,
            assigneeId: conversation.assigneeId,
            title: action.value?.trim() || `Follow up: ${conversation.chatName ?? conversation.chatId}`,
            dueAt,
            createdVia: 'automation',
          });
          return { type: action.type, ok: true };
        }
        case 'webhook': {
          if (!action.url) return { type: action.type, ok: false, detail: 'no url configured' };
          const response = await fetch(action.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              flow: flow.name,
              sessionId: conversation.sessionId,
              chatId: conversation.chatId,
              conversationId: conversation.id,
              body: incomingBody,
              firedAt: new Date().toISOString(),
            }),
            // A slow endpoint must not hold the inbound path open.
            signal: AbortSignal.timeout(5000),
          });
          return { type: action.type, ok: response.ok, detail: `HTTP ${response.status}` };
        }
        default:
          return { type: String(action.type), ok: false, detail: 'unknown action type' };
      }
    } catch (error) {
      return {
        type: String(action.type),
        ok: false,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      };
    }
  }

  /**
   * Resolve the text an automated reply sends.
   *
   * A quick-reply id is preferred over free text: it means automation can only send copy a human
   * already approved and can edit in one place. Variables are interpolated from what the
   * conversation actually knows.
   */
  private async resolveReplyText(action: FlowAction, conversation: Conversation): Promise<string> {
    const variables = {
      name: conversation.chatName ?? '',
      phone: phoneFromWaId(conversation.chatId) ?? '',
      agent_name: 'our team',
    };
    if (action.quickReplyId) {
      const reply = await this.quickReplies.get(action.quickReplyId);
      return interpolate(reply.body, variables);
    }
    return interpolate(action.value ?? '', variables);
  }

  private async tagNamesFor(conversationId: string): Promise<string[]> {
    const links = await this.conversationTags.find({ where: { conversationId } });
    if (links.length === 0) return [];
    const rows = await this.tags.find({ where: { id: In(links.map(l => l.tagId)) } });
    return rows.map(t => t.name);
  }

  private async record(
    flow: AutomationFlow,
    conversation: Conversation,
    outcome: 'matched' | 'skipped' | 'failed',
    reason: string | null,
    actionResults?: Array<{ type: string; ok: boolean; detail?: string }>,
  ): Promise<void> {
    // A `skipped: conditions_unmet` row for every flow on every message would bury the log it is
    // meant to make readable, so only decisions worth reviewing are stored.
    if (outcome === 'skipped' && reason === 'conditions_unmet') return;
    try {
      await this.executions.save(
        this.executions.create({
          flowId: flow.id,
          flowName: flow.name,
          conversationId: conversation.id,
          sessionId: conversation.sessionId,
          chatId: conversation.chatId,
          outcome,
          reason,
          actionResults: actionResults ?? null,
        }),
      );
    } catch (error) {
      this.logger.debug('Failed to write automation execution log', { error: String(error) });
    }
  }

  private businessHours(): BusinessHours {
    const start = parseClock(this.config?.get<string>('commandCenter.businessHoursStart'));
    const end = parseClock(this.config?.get<string>('commandCenter.businessHoursEnd'));
    const days = this.config?.get<number[]>('commandCenter.businessDays');
    return {
      startMinutes: start ?? DEFAULT_BUSINESS_HOURS.startMinutes,
      endMinutes: end ?? DEFAULT_BUSINESS_HOURS.endMinutes,
      days: days?.length ? days : DEFAULT_BUSINESS_HOURS.days,
    };
  }

  private inCooldown(flowId: string, conversationId: string): boolean {
    const until = this.cooldowns.get(`${flowId}:${conversationId}`);
    return until !== undefined && until > Date.now();
  }

  private enterCooldown(flow: AutomationFlow, conversationId: string): void {
    if (!flow.cooldownSeconds) return;
    if (this.cooldowns.size >= COOLDOWN_SWEEP_THRESHOLD) sweep(this.cooldowns);
    this.cooldowns.set(`${flow.id}:${conversationId}`, Date.now() + flow.cooldownSeconds * 1000);
  }

  private markAutomatedSend(key: string, cooldownSeconds: number): void {
    if (this.recentAutomatedSends.size >= COOLDOWN_SWEEP_THRESHOLD) sweep(this.recentAutomatedSends);
    // At least 30s of quiet after an automated send, regardless of how short the flow's cooldown is.
    this.recentAutomatedSends.set(key, Date.now() + Math.max(cooldownSeconds, 30) * 1000);
  }

  private resolveMessagePort(): PluginMessagePort | undefined {
    if (!this.messagePort) {
      try {
        // The same lazy token resolution the autoreply evaluator uses: a value import of
        // MessageService here would close a module cycle through SessionModule.
        this.messagePort = this.moduleRef?.get<typeof PLUGIN_MESSAGE_PORT, PluginMessagePort>(PLUGIN_MESSAGE_PORT, {
          strict: false,
        });
      } catch (error) {
        this.logger.warn('Message port unavailable; automation replies are disabled', { error: String(error) });
        return undefined;
      }
    }
    return this.messagePort;
  }
}

function sweep(map: Map<string, number>): void {
  const now = Date.now();
  for (const [key, until] of map) {
    if (until <= now) map.delete(key);
  }
}

function asPriority(value: string | undefined): ConversationPriority {
  const allowed = Object.values(ConversationPriority) as string[];
  return allowed.includes(value ?? '') ? (value as ConversationPriority) : ConversationPriority.NORMAL;
}

function asStatus(value: string | undefined): ConversationStatus {
  const allowed = Object.values(ConversationStatus) as string[];
  return allowed.includes(value ?? '') ? (value as ConversationStatus) : ConversationStatus.OPEN;
}
