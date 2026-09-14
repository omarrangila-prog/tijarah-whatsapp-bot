import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { ConversationService } from './conversation.service';
import { NoteService } from './note.service';
import { AgentService } from './agent.service';
import { RoutingService } from './routing.service';
import type { ConversationActor } from './visibility';
import { ConversationVisibilityGuard } from './conversation-visibility.guard';
import { EventsGateway } from '../events/events.gateway';
import {
  AddConversationTagDto,
  AssignConversationDto,
  TransferConversationDto,
  CreateNoteDto,
  ListConversationsQueryDto,
  UpdateConversationFlagsDto,
  UpdateConversationPriorityDto,
  UpdateConversationStatusDto,
} from './dto/conversation.dto';

/**
 * The unified inbox.
 *
 * These routes carry no `:sessionId` segment — a conversation is addressed by its own id and the
 * list spans every number — so the ApiKeyGuard's route-param session fence cannot reach them. Each
 * handler therefore re-applies the calling key's `allowedSessions` itself: the list intersects the
 * requested sessions with the key's allowlist, and every single-conversation route runs through
 * `ConversationService`, which refuses a row outside that fence. This is the same self-scoping
 * pattern `session.controller.ts :: findAll` and the integration-instance controller use, and each
 * handler is registered with its reason in `global-route-fence-coverage.spec.ts`.
 */
@ApiTags('Command Center — Conversations')
@UseGuards(ConversationVisibilityGuard)
@Controller('conversations')
export class ConversationController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly notes: NoteService,
    private readonly agents: AgentService,
    private readonly events: EventsGateway,
    private readonly routing: RoutingService,
  ) {}

  /**
   * Resolve who is asking and whether the ownership fence applies to them.
   *
   * Built per request rather than trusted from the client: the caller's agent identity comes from
   * the API key, so an agent cannot widen their own visibility by editing a query parameter.
   * Returns undefined when the fence is off, which keeps the unfenced path allocation-free and the
   * SQL unchanged for workspaces that never enable it.
   */
  private async visibilityFor(
    apiKey?: ApiKey,
  ): Promise<{ actor: ConversationActor; privateAssignedChats: boolean } | undefined> {
    const settings = await this.routing.getSettings();
    if (!settings.privateAssignedChats) return undefined;
    const agent = await this.agents.resolveActor(apiKey);
    return {
      actor: {
        agentId: agent?.id ?? null,
        role: agent?.role ?? (apiKey?.role as ConversationActor['role']) ?? 'operator',
      },
      privateAssignedChats: true,
    };
  }

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List conversations across every WhatsApp number the key can see' })
  @ApiResponse({ status: 200, description: 'A page of conversations, newest activity first' })
  async list(@Query() query: ListConversationsQueryDto, @CurrentApiKey() apiKey?: ApiKey) {
    // "me" is resolved here rather than in the service: only the controller knows which key is
    // calling. An unlinked key asking for "me" gets an empty list — which is the truthful answer,
    // since nothing can be assigned to an identity that does not exist.
    const assigneeId =
      query.assigneeId === 'me' ? ((await this.agents.resolveActor(apiKey))?.id ?? '__none__') : query.assigneeId;
    return this.conversations.list({ ...query, assigneeId }, apiKey?.allowedSessions, await this.visibilityFor(apiKey));
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiParam({ name: 'id', description: 'Conversation id' })
  @ApiOperation({ summary: 'Get one conversation with its tags' })
  async get(@Param('id', ParseUUIDPipe) id: string, @CurrentApiKey() apiKey?: ApiKey) {
    return this.conversations.findById(id, apiKey?.allowedSessions, await this.visibilityFor(apiKey));
  }

  @Post(':id/read')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Clear the unread badge' })
  markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentApiKey() apiKey?: ApiKey) {
    return this.conversations.markRead(id, apiKey?.allowedSessions);
  }

  @Post(':id/unread')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Flag the conversation as unread for follow-up' })
  markUnread(@Param('id', ParseUUIDPipe) id: string, @CurrentApiKey() apiKey?: ApiKey) {
    return this.conversations.markUnread(id, apiKey?.allowedSessions);
  }

  @Patch(':id/status')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Move the conversation between open, waiting and resolved' })
  setStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationStatusDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    return this.conversations.setStatus(id, dto.status, apiKey?.allowedSessions);
  }

  @Patch(':id/priority')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Set conversation priority' })
  setPriority(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationPriorityDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    return this.conversations.setPriority(id, dto.priority, apiKey?.allowedSessions);
  }

  @Patch(':id/flags')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Star or mute the conversation' })
  setFlags(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateConversationFlagsDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    return this.conversations.setFlags(id, dto, apiKey?.allowedSessions);
  }

  @Post(':id/assign')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Assign, reassign, or unassign a conversation' })
  async assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignConversationDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    const actor = await this.agents.resolveActor(apiKey);
    return this.conversations.assign(
      id,
      { agentId: dto.agentId, teamId: dto.teamId, reason: dto.reason },
      actor?.id ?? apiKey?.name ?? null,
      apiKey?.allowedSessions,
    );
  }

  @Post(':id/claim')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Take ownership of a conversation as the calling agent' })
  @ApiResponse({ status: 400, description: 'The calling API key is not linked to an agent' })
  async claim(@Param('id', ParseUUIDPipe) id: string, @CurrentApiKey() apiKey?: ApiKey) {
    const actor = await this.agents.resolveActor(apiKey);
    if (!actor) {
      // Refused rather than silently assigned to nobody: "claim" means "assign to ME", and without
      // a linked agent there is no me to assign to.
      return {
        error:
          'This API key is not linked to an agent yet. Create an agent for it on the Team page to claim conversations.',
      };
    }
    return this.conversations.assign(id, { agentId: actor.id }, actor.id, apiKey?.allowedSessions);
  }

  @Post(':id/transfer')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Hand this conversation to another agent',
    description:
      'Moves ownership AND the context: the handover note is recorded on the assignment trail and ' +
      'written into the conversation notes, so the incoming agent can pick the thread up without ' +
      'asking the customer to repeat themselves. A resolved conversation is reopened, because ' +
      'transferring a closed one means somebody is meant to act on it.',
  })
  async transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransferConversationDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    const actor = await this.agents.resolveActor(apiKey);
    const conversation = await this.conversations.transfer(
      id,
      { toAgentId: dto.toAgentId, toTeamId: dto.toTeamId, note: dto.note },
      { id: actor?.id ?? null, name: actor?.name ?? apiKey?.name ?? null },
      apiKey?.allowedSessions,
    );

    // The handover note is also a team note, because that is where the receiving agent reads the
    // history of a conversation — the assignment trail answers a different question.
    if (dto.note?.trim()) {
      const note = await this.notes.create(id, `Handover note: ${dto.note.trim()}`, {
        id: actor?.id,
        name: actor?.name ?? apiKey?.name,
      });
      this.events.emitConversationNote(conversation.sessionId, { conversationId: id, note });
    }

    return conversation;
  }

  @Get(':id/assignment-history')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Who has owned this conversation, and when' })
  async assignmentHistory(@Param('id', ParseUUIDPipe) id: string, @CurrentApiKey() apiKey?: ApiKey) {
    // Resolve first so an out-of-scope conversation is refused before any history is read.
    await this.conversations.findById(id, apiKey?.allowedSessions);
    return this.conversations.listAssignmentHistory(id);
  }

  // ------------------------------------------------------------------ notes

  @Get(':id/notes')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Internal notes on a conversation (never sent to WhatsApp)' })
  async listNotes(@Param('id', ParseUUIDPipe) id: string, @CurrentApiKey() apiKey?: ApiKey) {
    await this.conversations.findById(id, apiKey?.allowedSessions);
    return this.notes.list(id);
  }

  @Post(':id/notes')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Add an internal note' })
  @ApiResponse({ status: 201, description: 'The note. It is stored in this gateway only.' })
  async addNote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateNoteDto, @CurrentApiKey() apiKey?: ApiKey) {
    const conversation = await this.conversations.findById(id, apiKey?.allowedSessions);
    const actor = await this.agents.resolveActor(apiKey);
    const note = await this.notes.create(id, dto.body, { id: actor?.id, name: actor?.name ?? apiKey?.name });
    this.events.emitConversationNote(conversation.sessionId, { conversationId: id, note });
    return note;
  }

  @Patch(':id/notes/:noteId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Edit an internal note' })
  async updateNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @Body() dto: CreateNoteDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    await this.conversations.findById(id, apiKey?.allowedSessions);
    return this.notes.update(noteId, dto.body);
  }

  @Delete(':id/notes/:noteId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete an internal note' })
  async deleteNote(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    await this.conversations.findById(id, apiKey?.allowedSessions);
    await this.notes.remove(noteId);
    return { success: true };
  }

  // ------------------------------------------------------------------- tags

  @Post(':id/tags')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Attach a tag to a conversation' })
  async addTag(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddConversationTagDto,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    await this.conversations.findById(id, apiKey?.allowedSessions);
    return this.conversations.addTag(id, dto.tagId);
  }

  @Delete(':id/tags/:tagId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Remove a tag from a conversation' })
  async removeTag(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('tagId', ParseUUIDPipe) tagId: string,
    @CurrentApiKey() apiKey?: ApiKey,
  ) {
    await this.conversations.findById(id, apiKey?.allowedSessions);
    return this.conversations.removeTag(id, tagId);
  }
}
