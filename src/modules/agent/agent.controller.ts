import { Body, Controller, ForbiddenException, Get, Inject, Optional, Post, Query } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AgentRuntime } from './agent-runtime.service';
import { ApprovalService } from './approval.service';
import { AgentEventService } from './agent-event.service';
import { PermissionGuard } from '../../integrations/whatsapp/permission-guard';
import { SessionManager } from '../../integrations/whatsapp/session-manager';
import { WhatsAppGateway } from '../../integrations/whatsapp/whatsapp.gateway';
import { LEDGER_PORT, type LedgerPort } from '../../integrations/ledger/ledger.port';
import { AgentTurn } from './entities/agent-turn.entity';
import { AgentApproval } from './entities/agent-approval.entity';
import { AgentEvent } from './entities/agent-event.entity';
import { CustomerProfile } from '../command-center/entities/customer-profile.entity';

/**
 * Operating surface for the WhatsApp agent channel.
 *
 * Read routes for the dashboard, and two write routes an administrator needs: the
 * emergency stop, and a way to put a message through the agent without a phone.
 *
 * **No route here sends a WhatsApp message on the caller's behalf.** `simulate` runs a turn
 * exactly as an inbound message would, which means anything outbound it proposes still goes
 * through the permission layer and lands as an approval — the endpoint is a way into the
 * pipeline, not around it.
 */
@ApiTags('Agent Channel')
@Controller('agent')
export class AgentController {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly events: AgentEventService,
    private readonly permissions: PermissionGuard,
    private readonly sessions: SessionManager,
    private readonly gateway: WhatsAppGateway,
    private readonly runtime: AgentRuntime,
    @InjectRepository(AgentTurn, 'data') private readonly turnRows: Repository<AgentTurn>,
    @InjectRepository(AgentApproval, 'data') private readonly approvalRows: Repository<AgentApproval>,
    @InjectRepository(AgentEvent, 'data') private readonly eventRows: Repository<AgentEvent>,
    @InjectRepository(CustomerProfile, 'data') private readonly profiles: Repository<CustomerProfile>,
    @Optional() @Inject(LEDGER_PORT) private readonly ledger?: LedgerPort,
  ) {}

  @Get('status')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Agent mode, connection state and what is waiting' })
  async status(): Promise<Record<string, unknown>> {
    const settings = await this.permissions.loadSettings();
    const pending = await this.approvals.listPending(50);
    const outboundSession = this.sessions.outboundSessionId;
    return {
      mode: settings.mode,
      automationHalted: settings.automationHalted,
      haltedReason: settings.haltedReason,
      unknownSenderPolicy: settings.unknownSenderPolicy,
      quietHours: {
        start: settings.quietHoursStart,
        end: settings.quietHoursEnd,
        timezone: settings.timezone,
      },
      limits: {
        perDay: settings.maxAutomaticSendsPerDay,
        perContactPerDay: settings.maxAutomaticSendsPerContactPerDay,
        turnsPerSenderPerHour: settings.maxTurnsPerSenderPerHour,
      },
      approvalTtlMinutes: settings.approvalTtlMinutes,
      pendingApprovals: pending.length,
      outboundSession: outboundSession ?? null,
      whatsapp: outboundSession ? await this.sessions.status() : null,
      reasoning: this.runtime.reasoningStatus(),
    };
  }

  /**
   * What the accounting system currently says is owed.
   *
   * The same `LedgerPort` the agent's own tools read, so a screen showing this and a
   * conversation side by side is showing one source of truth rather than two that happen to
   * agree. Read-only: nothing here can alter a balance.
   */
  @Get('ledger')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Live receivables, read from the connected accounting system' })
  async ledgerState(): Promise<Record<string, unknown>> {
    if (!this.ledger) return { connected: false, adapter: null, rows: [] };
    const [health, rows] = await Promise.all([
      this.ledger.health().catch(() => null),
      this.ledger.listReceivables({ bucket: 'all', limit: 50 }),
    ]);
    return {
      connected: health?.ok ?? true,
      adapter: this.ledger.name,
      asOf: new Date().toISOString(),
      rows: rows.map(row => ({
        partyId: row.party.externalId,
        name: row.party.name,
        outstanding: row.outstanding,
        daysOverdue: row.daysOverdue,
        oldestDueDate: row.oldestDueDate,
        invoices: row.invoiceCount,
      })),
    };
  }

  @Get('approvals')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Prepared actions waiting on a human' })
  async pending(): Promise<Record<string, unknown>[]> {
    return (await this.approvals.listPending(100)).map(row => ({
      reference: row.reference,
      tool: row.toolName,
      summary: row.summary,
      requestedBy: row.requestedByPhone,
      recipient: row.recipientPhone,
      state: row.state,
      expiresAt: row.expiresAt,
    }));
  }

  @Get('events')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Scheduled events the agent has been handed' })
  async recentEvents(): Promise<Record<string, unknown>[]> {
    return (await this.events.listRecent(50)).map(row => ({
      eventType: row.eventType,
      eventKey: row.eventKey,
      state: row.state,
      detail: row.outcomeDetail,
      runAfter: row.runAfter,
    }));
  }

  /**
   * The emergency stop (brief §13).
   *
   * Admin only, and it takes effect on the next turn rather than at some later sweep: the
   * runtime reads this at the top of every turn and before executing any approval.
   */
  @Post('automation')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Stop or resume all automation' })
  async setAutomation(
    @Body() body: { halted: boolean; reason?: string },
    @CurrentApiKey() apiKey: ApiKey,
  ): Promise<{ automationHalted: boolean; reason: string | null }> {
    const settings = await this.permissions.loadSettings();
    settings.automationHalted = Boolean(body.halted);
    settings.haltedReason = body.halted ? (body.reason ?? 'Stopped from the dashboard') : null;
    settings.haltedAt = body.halted ? new Date() : null;
    settings.haltedBy = body.halted ? apiKey.name : null;
    await this.permissions.saveSettings(settings);
    return { automationHalted: settings.automationHalted, reason: settings.haltedReason };
  }

  /**
   * Puts a message through the agent as though it had arrived on WhatsApp.
   *
   * Admin only. The turn runs with the real runtime, the real permission layer and the real
   * tool registry — the only thing simulated is the arrival, so what it proves is what would
   * actually happen. Message ids are prefixed `sim.` so a simulated turn is never mistaken
   * for a real one in the audit trail.
   */
  @Post('simulate')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Run one inbound message through the agent (does not touch WhatsApp)' })
  async simulate(
    @Body() body: { from: string; text: string; sessionId?: string; type?: string },
  ): Promise<{ replied: boolean; text: string | null }> {
    const digits = String(body.from ?? '').replace(/\D/g, '');
    return this.gateway.handleInbound(body.sessionId ?? 'simulated', {
      id: `sim.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
      from: `${digits}@c.us`,
      body: String(body.text ?? ''),
      // `type` lets a voice note or photo arrival be rehearsed; the default is a text message.
      type: body.type?.trim() || 'chat',
      timestamp: Math.floor(Date.now() / 1000),
    });
  }

  /**
   * Clears the agent's own history so a demonstration can be run again.
   *
   * Only reachable when the channel is in demonstration mode. A route that erases an audit
   * trail must not exist on a real deployment at all, which is why this checks the mode
   * rather than relying on the ADMIN role alone: the whole point of the trail is that the
   * people who can act cannot quietly unwrite what they did.
   *
   * The ledger is untouched. A payment recorded during a demonstration stays recorded,
   * because an integration that forgets writes on request is not the one being sold.
   */
  @Post('demo/reset')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Demonstration mode only: clear turns, approvals, notes and opt-outs' })
  async resetDemo(): Promise<Record<string, unknown>> {
    if (process.env.AGENT_WHATSAPP_MOCK !== 'true') {
      throw new ForbiddenException('Available only when the agent channel is in demonstration mode.');
    }
    await this.turnRows.clear();
    await this.approvalRows.clear();
    await this.eventRows.clear();

    // Opt-outs are real state a customer set; clearing them is part of resetting the story.
    const optedOut = await this.profiles.find();
    for (const profile of optedOut) {
      if (profile.customFields?.['waOptOut'] === 'true') {
        profile.customFields = { ...profile.customFields, waOptOut: 'false' };
        await this.profiles.save(profile);
      }
    }
    return { reset: true, ledger: 'unchanged' };
  }

  @Get('turns')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Recent agent turns, with the tool calls and decisions' })
  async turns(@Query('limit') limit?: string): Promise<Record<string, unknown>[]> {
    return this.permissions.recentTurns(Math.min(Number(limit) || 25, 100));
  }
}
