import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Request } from 'express';
import { ApiKey } from '../auth/entities/api-key.entity';
import { Conversation } from './entities/conversation.entity';
import { AgentService } from './agent.service';
import { RoutingService } from './routing.service';
import { canSeeConversation, type ConversationActor } from './visibility';

/**
 * Extends the private-chat fence to the session message routes.
 *
 * Without this the fence is decorative. The inbox hides a colleague's conversation, but the message
 * bodies themselves are served by `sessions/:sessionId/messages`, which is fenced by API-key session
 * scope only — every agent on the same WhatsApp number passes that check. An agent who knew a
 * customer's number could therefore read, and reply into, a conversation the inbox had hidden from
 * them.
 *
 * Applies to reads and sends alike: being unable to see a conversation must also mean being unable
 * to write into it, or one agent could interject into another's thread unseen.
 *
 * Inert unless `privateAssignedChats` is on, so the default deployment keeps the original OpenWA
 * message routes byte-for-byte unchanged.
 */
@Injectable()
export class ChatVisibilityGuard implements CanActivate {
  constructor(
    @InjectRepository(Conversation, 'data') private readonly conversations: Repository<Conversation>,
    private readonly agents: AgentService,
    private readonly routing: RoutingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { apiKey?: ApiKey }>();

    const settings = await this.routing.getSettings();
    if (!settings.privateAssignedChats) return true;

    const agent = await this.agents.resolveActor(request.apiKey);
    const actor: ConversationActor = {
      agentId: agent?.id ?? null,
      role: agent?.role ?? (request.apiKey?.role as ConversationActor['role']) ?? 'operator',
    };
    // Admins are not fenced, so skip the lookup entirely for them.
    if (actor.role === 'admin') return true;

    const params = (request.params ?? {}) as Record<string, string>;
    const query = (request.query ?? {}) as Record<string, unknown>;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const sessionId = params.sessionId;
    const chatId =
      params.chatId ??
      (typeof query.chatId === 'string' ? query.chatId : undefined) ??
      (typeof body.chatId === 'string' ? body.chatId : undefined);

    if (!chatId) {
      // An unfiltered listing would return every chat's messages on the number, which is precisely
      // what the fence exists to prevent. Refused explicitly rather than silently emptied, so the
      // caller learns the rule instead of concluding the mailbox is empty.
      throw new ForbiddenException(
        'Private chats are on: request messages for one chatId rather than the whole number',
      );
    }
    if (!sessionId) return true;

    const row = await this.conversations.findOne({
      where: { sessionId, chatId },
      select: { id: true, assigneeId: true },
    });
    // A chat with no conversation row yet is unowned, and unowned means shared-queue visible.
    if (!row) return true;

    if (!canSeeConversation(row.assigneeId, actor, true)) {
      throw new NotFoundException('Conversation not found');
    }
    return true;
  }
}
