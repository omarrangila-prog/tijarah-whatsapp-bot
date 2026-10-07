import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan } from 'typeorm';
import { ApiKeyRole } from '../../modules/auth/entities/api-key.entity';
import { AgentSettings } from '../../modules/agent/entities/agent-settings.entity';
import { AgentToolPolicy, type ToolPermissionLevel } from '../../modules/agent/entities/agent-tool-policy.entity';
import { AgentTurn } from '../../modules/agent/entities/agent-turn.entity';
import { CustomerProfile } from '../../modules/command-center/entities/customer-profile.entity';
import { AgentApproval } from '../../modules/agent/entities/agent-approval.entity';
import type { SenderRole } from './agent-message.types';
import { normalizePhone } from './contact-mapper';

/**
 * The gate every proposed tool call passes through.
 *
 * The model proposes; this decides. Nothing the model returns reaches an engine without a
 * verdict from here, and the verdict is computed from stored policy and the sender's role —
 * never from anything in the message.
 *
 * The layering, strictest wins:
 *
 *   1. Emergency stop      — halts everything outbound, immediately.
 *   2. Customer fence      — a customer may only ever touch their own account.
 *   3. Stored tool policy  — ALLOW_AUTOMATICALLY / REQUIRE_APPROVAL / DENY.
 *   4. Deployment mode     — manual and assisted downgrade "allow" to "requires approval".
 *   5. Rate and quiet-hour limits — apply to unattended sends only.
 *
 * A policy may be stricter than the mode. It may never be bolder: an ALLOW_AUTOMATICALLY
 * policy in manual mode still requires a human, because the mode is the ceiling.
 */

export type PermissionDecision = 'allowed' | 'requires_approval' | 'denied';

export interface PermissionVerdict {
  decision: PermissionDecision;
  /** A sentence that can be shown to the requester. Never a code. */
  reason: string;
  /** The policy row consulted, for the audit trail. */
  policyLevel: ToolPermissionLevel;
}

export interface PermissionRequest {
  toolName: string;
  senderRole: SenderRole | 'system';
  senderPhone: string | null;
  /** The number this call would message, when it messages anyone. */
  recipientPhone: string | null;
  /**
   * True when the tool can only ever act on the sender's own number.
   *
   * Set from the descriptor's `senderScoped`, which the runtime enforces by overwriting the
   * recipient with the verified sender before the tool runs. It is not a claim the caller
   * makes about itself — it is a property of the tool.
   */
  selfAddressed?: boolean;
  /** The contact this call would read, when it reads one. */
  targetContactId: string | null;
  /** True when the tool changes something outside the system. */
  isWrite: boolean;
}

/**
 * Tools a customer may cause to run, and nothing else.
 *
 * An allowlist rather than a denylist, because the tool registry grows and a denylist
 * silently grants every tool added after it was written. A customer asking for "their
 * statement" ends up here; a customer asking to message someone else does not, whatever
 * words they use.
 */
/**
 * Tools a Tijarah client may cause to run, and nothing else.
 *
 * Every one of these is `senderScoped`, so it acts on the client's own company and nobody
 * else's. What is absent matters as much: no contact search, no sending to other numbers, no
 * receivables self-service (that is a different business's ledger, not theirs).
 */
const CLIENT_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'ListAccountingReports',
  'RequestAccountingReport',
  // Reads only this client's own remembered customers, so a name can replace an account code.
  'FindCustomerByName',
  'ListCreatableDocuments',
  'StartDocumentDraft',
  'SetDraftField',
  'AnswerDraftPrompt',
  'AddDraftLineItem',
  'ComposeDocument',
  'ReviewDraft',
  'SubmitDraftForApproval',
  'CancelDraft',
  'AgentRequestHuman',
  'AgentOptOut',
]);

const CUSTOMER_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'AgentSelfStatement',
  'AgentSelfInvoice',
  'AgentSelfBalance',
  'AgentSubmitPaymentReference',
  'AgentRecordPromiseToPay',
  'AgentRaiseDispute',
  'AgentRequestHuman',
  'AgentOptOut',
]);

/**
 * Tools no WhatsApp message may ever trigger, at any role.
 *
 * These are the brief's §12 prohibitions expressed as code. An admin can do all of these
 * through the dashboard, where there is a session, a screen and no possibility that the
 * instruction came from text a stranger wrote. Over WhatsApp they are simply off.
 */
const NEVER_OVER_WHATSAPP: ReadonlySet<string> = new Set([
  'SessionDelete',
  'SessionLogout',
  'SessionCreate',
  'SessionRestart',
  'ContactBlock',
  'ContactUnblock',
  'GroupCreate',
  'GroupAddParticipants',
  'LabelDelete',
  'WebhookCreate',
  'WebhookDelete',
  'WebhookUpdate',
  'AutomationRuleCreate',
  'AutomationRuleUpdate',
  'AutomationRuleDelete',
]);

@Injectable()
export class PermissionGuard {
  constructor(
    @InjectRepository(AgentSettings, 'data') private readonly settings: Repository<AgentSettings>,
    @InjectRepository(AgentToolPolicy, 'data') private readonly policies: Repository<AgentToolPolicy>,
    @InjectRepository(AgentTurn, 'data') private readonly turns: Repository<AgentTurn>,
    @InjectRepository(AgentApproval, 'data') private readonly approvals: Repository<AgentApproval>,
    @InjectRepository(CustomerProfile, 'data') private readonly profiles: Repository<CustomerProfile>,
  ) {}

  async loadSettings(): Promise<AgentSettings> {
    const existing = await this.settings.findOne({ where: { id: 'default' } });
    if (existing) return existing;
    // Created on first read with conservative defaults, so a fresh install is in manual mode
    // rather than in whatever mode a missing row would imply.
    const created = this.settings.create({ id: 'default' });
    return this.settings.save(created);
  }

  /** The role a WhatsApp sender acts as when the runtime executes a tool on their behalf. */
  static apiRoleFor(senderRole: SenderRole | 'system'): ApiKeyRole {
    switch (senderRole) {
      case 'admin':
        return ApiKeyRole.ADMIN;
      // A client's tools are declared at OPERATOR tier; `CLIENT_ALLOWED_TOOLS` above is what
      // keeps a client to the Tijarah set, not the rank.
      case 'staff':
      case 'system':
      case 'client':
        return ApiKeyRole.OPERATOR;
      default:
        // Customers and strangers get the lowest rung. Their tools are serviced by the
        // agent's own handlers rather than by the general registry anyway.
        return ApiKeyRole.VIEWER;
    }
  }

  /**
   * Whether a customer may use this tool at all.
   *
   * Exposed so the runtime can filter the list it offers, not just refuse afterwards. A
   * customer who is never shown `LedgerListOverdue` cannot spend a turn being told no, and
   * a model reasoning on their behalf is not invited to try.
   */
  static isCustomerAllowed(toolName: string): boolean {
    return CUSTOMER_ALLOWED_TOOLS.has(toolName);
  }

  /** Whether a Tijarah client may use this tool at all. */
  static isClientAllowed(toolName: string): boolean {
    return CLIENT_ALLOWED_TOOLS.has(toolName);
  }

  async evaluate(request: PermissionRequest): Promise<PermissionVerdict> {
    const settings = await this.loadSettings();

    /* 1. Emergency stop. */
    if (settings.automationHalted && request.isWrite) {
      return {
        decision: 'denied',
        reason: `Automation is stopped${settings.haltedReason ? `: ${settings.haltedReason}` : ''}. An administrator must resume it before anything can be sent.`,
        policyLevel: 'DENY',
      };
    }

    /* 2. Hard prohibitions. */
    if (NEVER_OVER_WHATSAPP.has(request.toolName)) {
      return {
        decision: 'denied',
        reason: 'That action cannot be performed over WhatsApp. Use the dashboard.',
        policyLevel: 'DENY',
      };
    }

    /*
     * 2b. The recipient has asked not to be contacted.
     *
     * Checked here rather than at the send tool so it covers every route to an outbound
     * message — a reminder, a scheduled follow-up, an approved send an administrator raised
     * before the opt-out arrived. Only outbound actions are gated: this never stops the
     * agent answering someone who has just messaged it, which is a reply rather than
     * contact they did not ask for.
     */
    if (request.isWrite && request.recipientPhone) {
      const recipient = normalizePhone(request.recipientPhone);
      if (recipient) {
        const profile = await this.profiles.findOne({ where: { phone: recipient } });
        if (profile?.customFields?.['waOptOut'] === 'true') {
          return {
            decision: 'denied',
            reason: 'That number has asked not to be contacted, so nothing can be sent to it.',
            policyLevel: 'DENY',
          };
        }
      }
    }

    /* 3. The client fence: their own company's books and documents, nothing else. */
    if (request.senderRole === 'client' && !CLIENT_ALLOWED_TOOLS.has(request.toolName)) {
      return {
        decision: 'denied',
        reason: 'That is not something this number is allowed to ask for.',
        policyLevel: 'DENY',
      };
    }

    /* 3. The customer fence. */
    if (request.senderRole === 'customer' || request.senderRole === 'unknown') {
      if (!CUSTOMER_ALLOWED_TOOLS.has(request.toolName)) {
        return {
          decision: 'denied',
          reason: 'That is not something this number is allowed to ask for.',
          policyLevel: 'DENY',
        };
      }
      // A customer's own tools may never be aimed at another number.
      if (request.recipientPhone && normalizePhone(request.recipientPhone) !== normalizePhone(request.senderPhone)) {
        return {
          decision: 'denied',
          reason: 'A customer can only ever act on their own account.',
          policyLevel: 'DENY',
        };
      }
    }

    /* 4. Stored policy, defaulting closed. */
    const policy = await this.policies.findOne({
      where: { toolName: request.toolName, senderRole: request.senderRole },
    });
    const level: ToolPermissionLevel = policy?.level ?? (request.isWrite ? 'REQUIRE_APPROVAL' : 'ALLOW_AUTOMATICALLY');

    if (level === 'DENY') {
      return {
        decision: 'denied',
        reason: policy?.note ?? 'This action is switched off for this role.',
        policyLevel: 'DENY',
      };
    }

    // A recipient allowlist, when set, is exhaustive.
    if (level === 'ALLOW_AUTOMATICALLY' && policy?.allowedRecipients?.length && request.recipientPhone) {
      const recipient = normalizePhone(request.recipientPhone);
      if (!recipient || !policy.allowedRecipients.includes(recipient)) {
        return {
          decision: 'requires_approval',
          reason: 'This recipient is not on the automatic list for this action, so it needs approval.',
          policyLevel: level,
        };
      }
    }

    if (level === 'REQUIRE_APPROVAL') {
      return { decision: 'requires_approval', reason: 'This action needs a person to approve it.', policyLevel: level };
    }

    /*
     * 5. The mode ceiling. Reads are unaffected; only outbound actions are gated.
     *
     * A self-addressed action is exempt, and only when a stored policy has explicitly allowed
     * it. The ceiling exists so a business opts in before the agent messages CUSTOMERS
     * unattended; sending an administrator their own report is not that, and requiring a
     * second administrator to approve someone fetching their own ledger is friction with
     * nothing on the other side of it. Both conditions must hold — the default for a write is
     * still REQUIRE_APPROVAL, so a senderScoped tool with no policy stays gated.
     */
    const selfServiceAllowed = request.selfAddressed === true && level === 'ALLOW_AUTOMATICALLY';
    if (request.isWrite && settings.mode !== 'automatic' && !selfServiceAllowed) {
      return {
        decision: 'requires_approval',
        reason:
          settings.mode === 'manual'
            ? 'The agent is in manual mode, so nothing is sent without approval.'
            : 'The agent is in assisted mode, so it prepares and a person approves.',
        policyLevel: level,
      };
    }

    /*
     * 6. Limits, for genuinely unattended sends.
     *
     * Exempt for the same self-addressed case, and for the same reason. Quiet hours and daily
     * caps exist so a CUSTOMER is not messaged at midnight or five times a day. Someone asking
     * for their own ledger at 23:00 is awake, is the one who asked, and is not protected by
     * being refused.
     */
    if (request.isWrite && !selfServiceAllowed) {
      const limit = await this.checkLimits(settings, request);
      if (limit) return limit;
    }

    return { decision: 'allowed', reason: 'Allowed by policy.', policyLevel: level };
  }

  /**
   * Daily caps and quiet hours.
   *
   * These bound the blast radius of a rule that misfires. The failure being defended
   * against is not a malicious one — it is an agent that reads its own reply as a new
   * request and answers it, which without a cap messages a customer all night.
   */
  private async checkLimits(settings: AgentSettings, request: PermissionRequest): Promise<PermissionVerdict | null> {
    if (isWithinQuietHours(new Date(), settings.timezone, settings.quietHoursStart, settings.quietHoursEnd)) {
      return {
        decision: 'requires_approval',
        reason: `It is outside sending hours (${settings.quietHoursStart}–${settings.quietHoursEnd} ${settings.timezone}), so this needs approval.`,
        policyLevel: 'REQUIRE_APPROVAL',
      };
    }

    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const sentToday = await this.approvals.count({
      where: { state: 'executed', decidedAt: MoreThan(since) },
    });
    if (sentToday >= settings.maxAutomaticSendsPerDay) {
      return {
        decision: 'requires_approval',
        reason: `The daily automatic limit of ${settings.maxAutomaticSendsPerDay} has been reached.`,
        policyLevel: 'REQUIRE_APPROVAL',
      };
    }

    if (request.recipientPhone) {
      const recipient = normalizePhone(request.recipientPhone);
      const perContact = await this.approvals.count({
        where: { state: 'executed', recipientPhone: recipient ?? undefined, decidedAt: MoreThan(since) },
      });
      if (perContact >= settings.maxAutomaticSendsPerContactPerDay) {
        return {
          decision: 'requires_approval',
          reason: `This contact has already received ${perContact} automatic messages today.`,
          policyLevel: 'REQUIRE_APPROVAL',
        };
      }
    }
    return null;
  }

  /** Persists a settings change made from the dashboard. */
  async saveSettings(settings: AgentSettings): Promise<AgentSettings> {
    return this.settings.save(settings);
  }

  /** Recent turns for the audit view. Reads only; the table is never edited. */
  async recentTurns(limit = 25): Promise<Record<string, unknown>[]> {
    const rows = await this.turns.find({ order: { createdAt: 'DESC' }, take: limit });
    return rows.map(row => ({
      at: row.createdAt,
      sender: row.senderPhone,
      role: row.senderRole,
      inbound: row.inboundText,
      reply: row.replyText,
      outcome: row.outcome,
      detail: row.outcomeDetail,
      injectionFlag: row.injectionFlag,
      actions: row.actions,
      provider: row.providerId,
      model: row.model,
    }));
  }

  /** Per-sender turn budget, so one number cannot exhaust the model spend. */
  async isRateLimited(senderPhone: string): Promise<boolean> {
    const settings = await this.loadSettings();
    const since = new Date(Date.now() - 3600 * 1000);
    const recent = await this.turns.count({ where: { senderPhone, createdAt: MoreThan(since) } });
    return recent >= settings.maxTurnsPerSenderPerHour;
  }
}

/**
 * Quiet hours in a named timezone.
 *
 * The window normally wraps midnight (21:00 → 09:00), which is the case worth getting
 * right: reversing the comparison enforces quiet hours through the working day and lifts
 * them overnight, which looks like it is working and is exactly wrong.
 */
export function isWithinQuietHours(now: Date, timezone: string, start: string, end: string): boolean {
  const minutes = localMinutes(now, timezone);
  const startMinutes = toMinutes(start, 21 * 60);
  const endMinutes = toMinutes(end, 9 * 60);
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? minutes >= startMinutes && minutes < endMinutes
    : minutes >= startMinutes || minutes < endMinutes;
}

function toMinutes(value: string, fallback: number): number {
  const [h, m] = String(value).split(':');
  const total = Number(h) * 60 + Number(m ?? 0);
  return Number.isFinite(total) ? total : fallback;
}

function localMinutes(now: Date, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hour = Number(parts.find(p => p.type === 'hour')?.value ?? 0) % 24;
    const minute = Number(parts.find(p => p.type === 'minute')?.value ?? 0);
    return hour * 60 + minute;
  } catch {
    // An unknown timezone costs correct quiet hours, not the whole turn.
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
}
