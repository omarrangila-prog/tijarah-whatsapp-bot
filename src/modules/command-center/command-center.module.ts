import { Module, OnApplicationBootstrap } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from '../message/entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { EventsModule } from '../events/events.module';
import { EventsGateway } from '../events/events.gateway';

import { Agent } from './entities/agent.entity';
import { Team } from './entities/team.entity';
import { TeamMember } from './entities/team-member.entity';
import { Conversation } from './entities/conversation.entity';
import { ConversationNote } from './entities/conversation-note.entity';
import { AssignmentHistory } from './entities/assignment-history.entity';
import { Tag } from './entities/tag.entity';
import { ConversationTag } from './entities/conversation-tag.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { ContactConsent } from './entities/contact-consent.entity';
import { QuickReply } from './entities/quick-reply.entity';
import { FollowUp } from './entities/follow-up.entity';
import { AiInsight } from './entities/ai-insight.entity';
import { AutomationFlow } from './entities/automation-flow.entity';
import { AutomationExecution } from './entities/automation-execution.entity';
import { ScheduledMessage } from './entities/scheduled-message.entity';
import { Broadcast } from './entities/broadcast.entity';
import { BroadcastRecipient } from './entities/broadcast-recipient.entity';
import { WorkspaceSettings } from './entities/workspace-settings.entity';

import { ConversationService, CONVERSATION_EVENT_SINK, type ConversationEventSink } from './conversation.service';
import { ConversationRecorder } from './conversation-recorder.service';
import { NoteService } from './note.service';
import { TagService } from './tag.service';
import { AgentService } from './agent.service';
import { CustomerService } from './customer.service';
import { QuickReplyService } from './quick-reply.service';
import { FollowUpService } from './follow-up.service';
import { AnalyticsService } from './analytics.service';
import { AutomationFlowService } from './automation-flow.service';
import { ScheduledMessageService } from './scheduled-message.service';
import { BroadcastService } from './broadcast.service';
import { PresenceService } from './presence.service';
import { RoutingService } from './routing.service';
import { conversationRecipientKeyIds } from './visibility';
import { ConversationVisibilityGuard } from './conversation-visibility.guard';
import { ChatVisibilityGuard } from './chat-visibility.guard';
import { AiService } from './ai/ai.service';
import { AnthropicAiProvider } from './ai/anthropic.provider';
import { HeuristicAiProvider } from './ai/heuristic.provider';

import { ConversationController } from './conversation.controller';
import { WorkspaceController } from './workspace.controller';
import { CustomerController } from './customer.controller';
import { AiController } from './ai.controller';
import { AutomationFlowController } from './automation-flow.controller';
import { BroadcastController } from './broadcast.controller';
import { AnalyticsController } from './analytics.controller';

/**
 * WA Command Center — the business layer over OpenWA's WhatsApp data.
 *
 * Deliberately imports NOTHING from SessionModule or MessageModule. The edge runs the other way:
 * SessionModule imports this module so `MessageProjector` can hold an optional `ConversationRecorder`,
 * exactly as it already holds `AutomationRulesService`. Sending is reached through the core-owned
 * `PLUGIN_MESSAGE_PORT` token, resolved lazily via `ModuleRef` at call time, so no module cycle is
 * created. `Session` and `Message` are registered here as REPOSITORIES only — entity access on the
 * shared `data` connection, not a dependency on the feature modules that own them.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature(
      [
        Agent,
        Team,
        TeamMember,
        Conversation,
        ConversationNote,
        AssignmentHistory,
        Tag,
        ConversationTag,
        CustomerProfile,
        ContactConsent,
        QuickReply,
        FollowUp,
        AiInsight,
        AutomationFlow,
        AutomationExecution,
        ScheduledMessage,
        Broadcast,
        BroadcastRecipient,
        WorkspaceSettings,
        Message,
        Session,
      ],
      'data',
    ),
    EventsModule,
  ],
  controllers: [
    ConversationController,
    WorkspaceController,
    CustomerController,
    AiController,
    AutomationFlowController,
    BroadcastController,
    AnalyticsController,
  ],
  providers: [
    ConversationService,
    ConversationRecorder,
    NoteService,
    TagService,
    AgentService,
    CustomerService,
    QuickReplyService,
    FollowUpService,
    AnalyticsService,
    AutomationFlowService,
    ScheduledMessageService,
    BroadcastService,
    PresenceService,
    RoutingService,
    ConversationVisibilityGuard,
    ChatVisibilityGuard,
    AiService,
    AnthropicAiProvider,
    HeuristicAiProvider,
    {
      // The realtime seam, bound to the gateway through a token rather than injected directly, so
      // ConversationService stays constructible in a unit test with no websocket server anywhere.
      provide: CONVERSATION_EVENT_SINK,
      useFactory: (events: EventsGateway, agents: AgentService, routing: RoutingService): ConversationEventSink => ({
        // The realtime half of the private-chat fence. A conversation the fence hides must not
        // arrive over the websocket either — otherwise the REST list hides it and the live update
        // pushes it straight back into the inbox, which is a leak that also looks like a bug.
        //
        // Fire-and-forget: resolving recipients needs the settings and the agent→key map (both
        // cached), and an event sink that made every caller await a database read would put the
        // realtime path in front of every conversation write.
        emitConversationUpdated: (sessionId, conversation) => {
          void (async () => {
            const settings = await routing.getSettings();
            if (!settings.privateAssignedChats) {
              events.emitConversationUpdated(sessionId, conversation as unknown as Record<string, unknown>);
              return;
            }
            const { assigneeKeyId, adminKeyIds } = await agents.recipientKeyIds(conversation.assigneeId);
            const recipients = conversationRecipientKeyIds(
              assigneeKeyId,
              adminKeyIds,
              true,
              Boolean(conversation.assigneeId),
            );
            events.emitConversationUpdated(sessionId, conversation as unknown as Record<string, unknown>, recipients);
          })().catch(() => {
            // Never let a fence lookup failure drop the event silently AND never let it broadcast a
            // private conversation by falling back to the open path: dropping is the safe failure.
          });
        },
      }),
      inject: [EventsGateway, AgentService, RoutingService],
    },
  ],
  exports: [
    ConversationRecorder,
    ConversationService,
    PresenceService,
    RoutingService,
    AgentService,
    ChatVisibilityGuard,
  ],
})
export class CommandCenterModule implements OnApplicationBootstrap {
  constructor(
    private readonly scheduled: ScheduledMessageService,
    private readonly broadcasts: BroadcastService,
  ) {}

  /**
   * Start the two background drains here rather than in the services' own `onModuleInit`, so
   * constructing either service in a test does not start a timer that outlives the test.
   */
  onApplicationBootstrap(): void {
    this.scheduled.start();
    this.broadcasts.start();
  }
}
