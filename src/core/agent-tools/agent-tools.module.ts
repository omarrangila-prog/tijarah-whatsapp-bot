import { Global, Module } from '@nestjs/common';
import { ToolRegistryService } from './tool-registry.service';
import { SessionModule } from '../../modules/session/session.module';
import { MessageModule } from '../../modules/message/message.module';
import { ContactModule } from '../../modules/contact/contact.module';
import { GroupModule } from '../../modules/group/group.module';
import { WebhookModule } from '../../modules/webhook/webhook.module';
import { LabelModule } from '../../modules/label/label.module';
import { AutomationModule } from '../../modules/automation/automation.module';
import { SessionService } from '../../modules/session/session.service';
import { MessageService } from '../../modules/message/message.service';
import { ContactService } from '../../modules/contact/contact.service';
import { GroupService } from '../../modules/group/group.service';
import { WebhookService } from '../../modules/webhook/webhook.service';
import { LabelService } from '../../modules/label/label.service';
import { AutomationRulesService } from '../../modules/automation/automation-rules.service';
import { ModuleRef } from '@nestjs/core';
import { ScheduledMessageService } from '../../modules/command-center/scheduled-message.service';
import { ApprovalService } from '../../modules/agent/approval.service';
import { ContactMapper } from '../../integrations/whatsapp/contact-mapper';
import { Message } from '../../modules/message/entities/message.entity';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { allAgentTools } from './tools';
import { agentTools } from './tools/agent.tools';
import { demoSendTools, DEMO_REPLACED_TOOLS } from '../../integrations/whatsapp/demo-send.tools';
import { MockWhatsAppProvider } from '../../integrations/whatsapp/mock.provider';
import { ledgerTools } from './tools/ledger.tools';
import { selfServiceTools } from './tools/self-service.tools';
import { whatsappJobTools } from './tools/whatsapp-jobs.tools';
import { reportRequestTools } from './tools/report-request.tools';
import { draftTools } from './tools/draft.tools';
import { DraftService } from '../../modules/whatsapp-jobs/drafts/draft.service';
import { BotUserService } from '../../modules/whatsapp-jobs/tenancy/bot-user.service';
import { WhatsAppJobsService } from '../../modules/whatsapp-jobs/whatsapp-jobs.service';
import { AgentEventService } from '../../modules/agent/agent-event.service';
import { LEDGER_PORT, type LedgerPort } from '../../integrations/ledger/ledger.port';

@Global()
@Module({
  imports: [SessionModule, MessageModule, ContactModule, GroupModule, WebhookModule, LabelModule, AutomationModule],
  providers: [
    {
      provide: ToolRegistryService,
      inject: [
        SessionService,
        MessageService,
        ContactService,
        GroupService,
        WebhookService,
        LabelService,
        AutomationRulesService,
        // The agent's own tools are registered into THIS registry rather than a second one,
        // so there is one tool list, one permission path and one place a new capability
        // lands. Their services are resolved through ModuleRef at call time — see
        // AgentToolDeps for why they cannot be injected here.
        ModuleRef,
      ],
      useFactory: (
        session: SessionService,
        message: MessageService,
        contact: ContactService,
        group: GroupService,
        webhook: WebhookService,
        labels: LabelService,
        automation: AutomationRulesService,
        moduleRef: ModuleRef,
      ) => {
        const lazy = <T>(token: Parameters<ModuleRef['get']>[0]): (() => T) => {
          let cached: T | undefined;
          return () => {
            cached ??= moduleRef.get<T>(token, { strict: false });
            return cached;
          };
        };
        /*
         * Demonstration mode swaps the three send tools for recording stand-ins.
         *
         * Same names, so there is still exactly one MessageSendText and every permission
         * rule, approval and audit row applies unchanged — only the last hop differs.
         */
        const demo = process.env.AGENT_WHATSAPP_MOCK === 'true';
        const base = allAgentTools({ session, message, contact, group, webhook, labels, automation });
        const live = demo ? base.filter(t => !DEMO_REPLACED_TOOLS.includes(t.name as never)) : base;

        return new ToolRegistryService([
          ...live,
          ...(demo ? demoSendTools({ transport: lazy<MockWhatsAppProvider>(MockWhatsAppProvider) }) : []),
          ...ledgerTools({ ledger: lazy<LedgerPort>(LEDGER_PORT) }),
          ...draftTools({ drafts: lazy<DraftService>(DraftService) }),
          ...reportRequestTools({
            jobs: lazy<WhatsAppJobsService>(WhatsAppJobsService),
            users: lazy<BotUserService>(BotUserService),
          }),
          ...whatsappJobTools({
            jobs: lazy<WhatsAppJobsService>(WhatsAppJobsService),
            contacts: lazy<ContactMapper>(ContactMapper),
          }),
          ...selfServiceTools({
            ledger: lazy<LedgerPort>(LEDGER_PORT),
            contacts: lazy<ContactMapper>(ContactMapper),
            events: lazy<AgentEventService>(AgentEventService),
          }),
          ...agentTools({
            scheduled: lazy<ScheduledMessageService>(ScheduledMessageService),
            approvals: lazy<ApprovalService>(ApprovalService),
            contacts: lazy<ContactMapper>(ContactMapper),
            messages: lazy<Repository<Message>>(getRepositoryToken(Message, 'data')),
          }),
        ]);
      },
    },
  ],
  exports: [ToolRegistryService],
})
export class AgentToolsModule {}
