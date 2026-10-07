import { Module, type Provider } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { DocumentTypeRegistry } from './entities/document-type-registry.entity';
import { DocumentDraft } from './drafts/document-draft.entity';
import { BotUser } from './tenancy/bot-user.entity';
import { BotUserService } from './tenancy/bot-user.service';
import { KnownParty } from './tenancy/known-party.entity';
import { KnownPartyService } from './tenancy/known-party.service';
import { TijarahApprovalSubmissionAdapter } from './drafts/tijarah-approval.adapter';
import { ApprovalOutcomeService } from './drafts/approval-outcome.service';
import { BotUserController } from './tenancy/bot-user.controller';
import { DraftService } from './drafts/draft.service';
import {
  APPROVAL_SUBMISSION_PORT,
  HttpApprovalSubmissionAdapter,
  MockApprovalSubmissionAdapter,
  readSubmissionEndpoint,
} from './drafts/approval-submission.port';
import { WhatsAppJobsService } from './whatsapp-jobs.service';
import { WhatsAppJobsController } from './whatsapp-jobs.controller';
import { MockDocumentApiController } from './mock-document-api.controller';
import { JobWorkerService } from './job-worker.service';
import { JobKpiService } from './kpi.service';
import { TijarahQueueService } from './tijarah-queue.service';
import { MockWhatsAppProvider } from '../../integrations/whatsapp/mock.provider';
import { MockDeliveryProvider, WHATSAPP_DELIVERY_PROVIDER } from './providers/whatsapp-delivery.provider';
import { EngineDeliveryProvider } from './providers/engine-delivery.provider';

/**
 * Phase 1: command → job → worker → document API → WhatsApp → status.
 *
 * The module imports no other feature module. The delivery provider reaches `SessionService`
 * and `MessageService` lazily through `ModuleRef`, which is this repo's documented way of
 * crossing that boundary without dragging the message and session graphs into a constructor
 * and re-creating the `events.gateway` ↔ `auth.service` cycle.
 */
/**
 * How a completed draft reaches the approval screen.
 *
 * Mock unless an approval endpoint is configured. Defaulting the other way would mean a fresh
 * install could post documents into a live accounting system the moment someone composed one
 * in chat — and the specification is explicit that these must land on an approval screen, not
 * as entries. An operator points this at the real endpoint once, deliberately.
 */
const approvalSubmission: Provider = {
  provide: APPROVAL_SUBMISSION_PORT,
  inject: [BotUserService],
  useFactory: (users: BotUserService) => {
    const { endpoint, authProfile } = readSubmissionEndpoint();
    if (!endpoint) return new MockApprovalSubmissionAdapter();
    /*
     * Tijarah's own endpoint wants its own envelope; anything else gets the flattened draft.
     * Matched on the path rather than configured, so pointing at Tijarah cannot be done with
     * the wrong adapter selected.
     */
    return /UpsertRequest/i.test(endpoint)
      ? new TijarahApprovalSubmissionAdapter(endpoint, users, authProfile)
      : new HttpApprovalSubmissionAdapter(endpoint, authProfile);
  },
};

const deliveryProvider: Provider = {
  provide: WHATSAPP_DELIVERY_PROVIDER,
  inject: [MockDeliveryProvider, EngineDeliveryProvider],
  useFactory: (mock: MockDeliveryProvider, engine: EngineDeliveryProvider) => {
    /*
     * Mock unless told otherwise.
     *
     * Defaulting to the real transport would mean a fresh install, a test run or a
     * half-configured staging box could message a customer the moment a job appeared. The
     * operator opts in to sending for real, once, deliberately.
     */
    return process.env.WHATSAPP_JOBS_MOCK === 'false' ? engine : mock;
  },
};

@Module({
  imports: [
    TypeOrmModule.forFeature([WhatsAppDocumentJob, DocumentTypeRegistry, DocumentDraft, BotUser, KnownParty], 'data'),
  ],
  controllers: [
    WhatsAppJobsController,
    BotUserController,
    // Mounted always, but every route checks `MockDocumentApiController.enabled()` — see below.
    MockDocumentApiController,
  ],
  providers: [
    WhatsAppJobsService,
    JobKpiService,
    JobWorkerService,
    TijarahQueueService,
    DraftService,
    BotUserService,
    KnownPartyService,
    ApprovalOutcomeService,
    approvalSubmission,
    MockWhatsAppProvider,
    MockDeliveryProvider,
    EngineDeliveryProvider,
    deliveryProvider,
  ],
  exports: [
    WhatsAppJobsService,
    JobKpiService,
    JobWorkerService,
    TijarahQueueService,
    DraftService,
    BotUserService,
    KnownPartyService,
    WHATSAPP_DELIVERY_PROVIDER,
  ],
})
export class WhatsAppJobsModule {}
