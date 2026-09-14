import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessageService } from './message.service';
import { MessageSendService } from './message-send.service';
import { BulkMessageService } from './bulk-message.service';
import { MessageTypeBackfillService } from './message-type-backfill.service';
import { PendingMessageReaperService } from './pending-message-reaper.service';
import { CommandCenterModule } from '../command-center/command-center.module';
import { MessageController } from './message.controller';
import { SessionModule } from '../session/session.module';
import { TemplateModule } from '../template/template.module';
import { ChatMediaModule } from '../chat-media/chat-media.module';
import { Message } from './entities/message.entity';
import { Session } from '../session/entities/session.entity';
import { SendPacingService } from './send-pacing.service';
import { MessageBatch } from './entities/message-batch.entity';
import { PLUGIN_MESSAGE_PORT } from '../../core/plugins/plugin-host-ports';
import { Conversation } from '../command-center/entities/conversation.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message, MessageBatch, Session], 'data'),
    // ChatVisibilityGuard is constructed in this module's context, so its Conversation repository
    // has to be registered here too.
    TypeOrmModule.forFeature([Conversation], 'data'),
    SessionModule,
    TemplateModule,
    ChatMediaModule,
    // Supplies ChatVisibilityGuard. The edge is safe: CommandCenterModule imports nothing from
    // SessionModule or MessageModule, so this adds no cycle.
    CommandCenterModule,
  ],
  controllers: [MessageController],
  providers: [
    MessageService,
    MessageSendService,
    BulkMessageService,
    MessageTypeBackfillService,
    PendingMessageReaperService,
    SendPacingService,
    // Binds the core-owned plugin capability port to this module's service. The plugin runtime
    // resolves the token lazily via ModuleRef (PluginHostServices), which keeps its provider cycle
    // broken; this adapter is how core reaches the service without importing it.
    // An alias, not a factory, so lifecycle hooks are not dispatched twice on the same instance.
    { provide: PLUGIN_MESSAGE_PORT, useExisting: MessageService },
  ],
  exports: [MessageService, BulkMessageService, SendPacingService],
})
export class MessageModule {}
