import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AgentService } from './agent.service';
import { PresenceService } from './presence.service';
import { RoutingService } from './routing.service';
import { EventsGateway } from '../events/events.gateway';
import { TagService } from './tag.service';
import { QuickReplyService } from './quick-reply.service';
import { ConversationService } from './conversation.service';
import { FollowUpService } from './follow-up.service';
import { ScheduledMessageService } from './scheduled-message.service';
import { phoneFromWaId } from './conversation-state';
import {
  AddTeamMemberDto,
  CreateAgentDto,
  CreateQuickReplyDto,
  CreateTagDto,
  CreateTeamDto,
  RenderQuickReplyDto,
  UpdateAgentDto,
  UpdateQuickReplyDto,
  UpdateTagDto,
  UpdateTeamDto,
} from './dto/workspace.dto';
import { HeartbeatDto, UpdateRoutingDto } from './dto/presence.dto';
import {
  CreateFollowUpDto,
  CreateScheduledMessageDto,
  ListFollowUpsQueryDto,
  ListScheduledMessagesQueryDto,
  UpdateFollowUpStatusDto,
} from './dto/task.dto';

/**
 * Workspace configuration: agents, teams, tags, quick replies, follow-ups and scheduled messages.
 *
 * `@RequireUnscopedKey()` at class level. These resources have no session dimension at all — a tag
 * or a team belongs to the whole workspace — so the guard's route-param fence can never bite, and a
 * session-restricted key must not be able to reshape the workspace it is confined inside. The one
 * session-dimensioned resource here, scheduled messages, is additionally checked against the key's
 * allowlist in the handler.
 */
@ApiTags('Command Center — Workspace')
@RequireUnscopedKey()
@Controller('workspace')
export class WorkspaceController {
  constructor(
    private readonly agents: AgentService,
    private readonly tags: TagService,
    private readonly quickReplies: QuickReplyService,
    private readonly conversations: ConversationService,
    private readonly followUps: FollowUpService,
    private readonly scheduled: ScheduledMessageService,
    private readonly presence: PresenceService,
    private readonly routing: RoutingService,
    private readonly events: EventsGateway,
  ) {}

  // ─────────────────────────────────────────────────────── live presence

  /**
   * Heartbeat: "I am here, and this is what I have open."
   *
   * One call every 20 seconds per agent carries both facts, because they always change together.
   * The response is the whole online roster plus the other viewers of the conversation the caller
   * has open, so a single round trip keeps the presence strip and the collision warning current
   * without a second request.
   */
  @Post('presence/heartbeat')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Report this agent as online and broadcast it to the team' })
  async heartbeat(@Body() dto: HeartbeatDto, @CurrentApiKey() apiKey?: ApiKey) {
    const actor = await this.agents.resolveActor(apiKey);
    if (!actor) {
      // A key with no linked agent is not a member of the shift; it can still read the roster.
      return { agent: null, online: this.presence.online(), viewers: [] };
    }

    this.presence.heartbeat({
      agentId: actor.id,
      name: actor.name,
      color: actor.color,
      viewingConversationId: dto.viewingConversationId ?? null,
      typing: dto.typing,
    });

    const viewers = dto.viewingConversationId ? this.presence.viewersOf(dto.viewingConversationId, actor.id) : [];

    // Broadcast on the wildcard room so every open inbox updates without polling. Presence is
    // workspace-wide rather than per-number, so it is announced once rather than per session.
    this.events.emitAgentPresence('*', { online: this.presence.online() });
    if (dto.viewingConversationId) {
      this.events.emitConversationViewers('*', {
        conversationId: dto.viewingConversationId,
        viewers: this.presence.viewersOf(dto.viewingConversationId),
      });
    }

    return { agent: actor, online: this.presence.online(), viewers };
  }

  @Post('presence/leave')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Drop this agent from the online roster immediately (sign-out, tab close)' })
  async leave(@CurrentApiKey() apiKey?: ApiKey) {
    const actor = await this.agents.resolveActor(apiKey);
    if (actor) {
      this.presence.release(actor.id);
      this.events.emitAgentPresence('*', { online: this.presence.online() });
    }
    return { success: true };
  }

  @Get('presence')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Who is online right now, and what each of them has open' })
  presenceRoster() {
    return { online: this.presence.online() };
  }

  // ──────────────────────────────────────────────────────────── routing

  @Get('routing')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'How inbound conversations are distributed across agents' })
  getRouting() {
    return this.routing.getSettings();
  }

  @Patch('routing')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Change the work-distribution strategy. Takes effect on the next message.' })
  updateRouting(@Body() dto: UpdateRoutingDto) {
    return this.routing.updateSettings(dto);
  }

  @Post('routing/distribute')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Share the waiting queue out across agents now',
    description:
      'Applies the current strategy to conversations that are already unassigned. Routing otherwise ' +
      'only fires when a new message arrives, so a backlog that built up before the strategy was ' +
      'changed would never be distributed. Returns what was assigned and why anything was skipped.',
  })
  async distributeQueue(@Body() body: { limit?: number }) {
    const result = await this.routing.distributeQueue(body?.limit ?? 50);
    // Announce each assignment so every open inbox reflects it without a refetch.
    for (const item of result.assigned) {
      const conversation = await this.conversations.findById(item.conversationId);
      this.events.emitConversationUpdated(conversation.sessionId, conversation as unknown as Record<string, unknown>);
    }
    return { assigned: result.assigned.length, skipped: result.skipped, reason: result.reason };
  }

  // ----------------------------------------------------------------- agents

  @Get('me')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'The agent the calling API key acts as, or null when it is not linked to one' })
  async me(@CurrentApiKey() apiKey?: ApiKey) {
    const agent = await this.agents.resolveActor(apiKey);
    return { agent, apiKeyId: apiKey?.id ?? null, apiKeyName: apiKey?.name ?? null, role: apiKey?.role ?? null };
  }

  @Get('agents')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List agents' })
  listAgents() {
    return this.agents.listAgents();
  }

  @Post('agents')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create an agent' })
  createAgent(@Body() dto: CreateAgentDto) {
    return this.agents.createAgent(dto);
  }

  @Patch('agents/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update an agent' })
  updateAgent(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAgentDto) {
    return this.agents.updateAgent(id, dto);
  }

  @Delete('agents/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Remove an agent' })
  async deleteAgent(@Param('id', ParseUUIDPipe) id: string) {
    await this.agents.deleteAgent(id);
    return { success: true };
  }

  // ------------------------------------------------------------------ teams

  @Get('teams')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List teams with their members' })
  listTeams() {
    return this.agents.listTeams();
  }

  @Post('teams')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Create a team' })
  createTeam(@Body() dto: CreateTeamDto) {
    return this.agents.createTeam(dto);
  }

  @Patch('teams/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Update a team' })
  updateTeam(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTeamDto) {
    return this.agents.updateTeam(id, dto);
  }

  @Delete('teams/:id')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Delete a team' })
  async deleteTeam(@Param('id', ParseUUIDPipe) id: string) {
    await this.agents.deleteTeam(id);
    return { success: true };
  }

  @Post('teams/:id/members')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Add an agent to a team' })
  addMember(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AddTeamMemberDto) {
    return this.agents.addMember(id, dto.agentId, dto.teamRole ?? 'member');
  }

  @Delete('teams/:id/members/:agentId')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Remove an agent from a team' })
  async removeMember(@Param('id', ParseUUIDPipe) id: string, @Param('agentId', ParseUUIDPipe) agentId: string) {
    await this.agents.removeMember(id, agentId);
    return { success: true };
  }

  // ------------------------------------------------------------------- tags

  @Get('tags')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List workspace tags' })
  listTags() {
    return this.tags.list();
  }

  @Post('tags')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a tag' })
  createTag(@Body() dto: CreateTagDto) {
    return this.tags.create(dto.name, dto.color);
  }

  @Patch('tags/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Rename or recolour a tag' })
  updateTag(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTagDto) {
    return this.tags.update(id, dto);
  }

  @Delete('tags/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a tag and detach it everywhere' })
  async deleteTag(@Param('id', ParseUUIDPipe) id: string) {
    await this.tags.remove(id);
    return { success: true };
  }

  // ---------------------------------------------------------- quick replies

  @Get('quick-replies')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List saved replies' })
  listQuickReplies(@Query('folder') folder?: string) {
    return this.quickReplies.list(folder);
  }

  @Get('quick-replies/folders')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List the folders quick replies are grouped into' })
  quickReplyFolders() {
    return this.quickReplies.folders();
  }

  @Post('quick-replies')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a saved reply' })
  createQuickReply(@Body() dto: CreateQuickReplyDto) {
    return this.quickReplies.create(dto);
  }

  @Post('quick-replies/seed-defaults')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Add a starter set of replies. Does nothing when any reply already exists.' })
  async seedQuickReplies() {
    const created = await this.quickReplies.seedDefaults();
    return { created };
  }

  @Patch('quick-replies/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a saved reply' })
  updateQuickReply(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateQuickReplyDto) {
    return this.quickReplies.update(id, dto);
  }

  @Delete('quick-replies/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a saved reply' })
  async deleteQuickReply(@Param('id', ParseUUIDPipe) id: string) {
    await this.quickReplies.remove(id);
    return { success: true };
  }

  @Post('quick-replies/:id/render')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Resolve a reply for one conversation: fill its placeholders and report any left unresolved',
  })
  async renderQuickReply(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenderQuickReplyDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    const actor = await this.agents.resolveActor(apiKey);
    const conversation = dto.conversationId
      ? await this.conversations.findById(dto.conversationId, apiKey?.allowedSessions)
      : null;
    return this.quickReplies.render(id, {
      name: conversation?.chatName ?? '',
      phone: conversation ? (phoneFromWaId(conversation.chatId) ?? '') : '',
      agent_name: actor?.name ?? apiKey?.name ?? '',
    });
  }

  // ------------------------------------------------------------ follow-ups

  @Get('follow-ups')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List follow-up reminders' })
  listFollowUps(@Query() query: ListFollowUpsQueryDto) {
    return this.followUps.list(query);
  }

  @Post('follow-ups')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a follow-up reminder' })
  createFollowUp(@Body() dto: CreateFollowUpDto) {
    return this.followUps.create({ ...dto, dueAt: new Date(dto.dueAt) });
  }

  @Patch('follow-ups/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Complete or cancel a follow-up' })
  updateFollowUp(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFollowUpStatusDto) {
    return this.followUps.setStatus(id, dto.status);
  }

  @Delete('follow-ups/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a follow-up' })
  async deleteFollowUp(@Param('id', ParseUUIDPipe) id: string) {
    await this.followUps.remove(id);
    return { success: true };
  }

  // ---------------------------------------------------- scheduled messages

  @Get('scheduled-messages')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List messages queued to send later' })
  listScheduled(@Query() query: ListScheduledMessagesQueryDto) {
    return this.scheduled.list(query);
  }

  @Post('scheduled-messages')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Queue a message to send at a future time' })
  createScheduled(@Body() dto: CreateScheduledMessageDto, @CurrentApiKey() apiKey?: ApiKey) {
    return this.scheduled.create({
      sessionId: dto.sessionId,
      chatId: dto.chatId,
      body: dto.body,
      runAt: new Date(dto.runAt),
      createdBy: apiKey?.name ?? null,
    });
  }

  @Delete('scheduled-messages/:id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Cancel a queued message' })
  cancelScheduled(@Param('id', ParseUUIDPipe) id: string) {
    return this.scheduled.cancel(id);
  }
}
