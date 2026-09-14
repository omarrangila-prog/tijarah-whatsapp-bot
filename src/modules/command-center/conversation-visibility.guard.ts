import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { ApiKey } from '../auth/entities/api-key.entity';
import { Conversation } from './entities/conversation.entity';
import { AgentService } from './agent.service';
import { RoutingService } from './routing.service';
import { canSeeConversation, type ConversationActor } from './visibility';

/**
 * Enforces the private-chat fence on every route addressed by conversation id.
 *
 * A guard rather than a parameter threaded through each service method, because the fence has to
 * hold for routes that do not exist yet. There are already more than a dozen `:id` endpoints here
 * (status, priority, flags, notes, tags, assignment history, transfer); a rule that must be
 * remembered at fifteen call sites is a rule that will eventually be forgotten at the sixteenth,
 * and the failure mode is silent — a new endpoint quietly serving one agent another agent's
 * customer conversation.
 *
 * Reads only the assignee column: the guard decides visibility, and loading the full row here would
 * duplicate the fetch the handler is about to do anyway.
 */
@Injectable()
export class ConversationVisibilityGuard implements CanActivate {
  constructor(
    @InjectRepository(Conversation, 'data') private readonly conversations: Repository<Conversation>,
    private readonly agents: AgentService,
    private readonly routing: RoutingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { apiKey?: ApiKey }>();
    const id = (request.params as Record<string, string> | undefined)?.id;
    // Collection routes (no :id) are fenced by the list query itself, not here.
    if (!id) return true;

    const settings = await this.routing.getSettings();
    if (!settings.privateAssignedChats) return true;

    const row = await this.conversations.findOne({ where: { id }, select: { id: true, assigneeId: true } });
    // Let the handler produce the real 404 for an id that does not exist, so a missing conversation
    // and a hidden one stay indistinguishable from outside.
    if (!row) return true;

    const agent = await this.agents.resolveActor(request.apiKey);
    const actor: ConversationActor = {
      agentId: agent?.id ?? null,
      role: agent?.role ?? (request.apiKey?.role as ConversationActor['role']) ?? 'operator',
    };

    if (!canSeeConversation(row.assigneeId, actor, true)) {
      // 404, not 403 — see ConversationService.assertVisible for why the fence must not confirm
      // that the conversation exists.
      throw new NotFoundException('Conversation not found');
    }
    return true;
  }
}
