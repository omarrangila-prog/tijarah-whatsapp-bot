import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { WhatsAppJobsService } from './whatsapp-jobs.service';
import { JobKpiService, type DocumentTypeKpi } from './kpi.service';
import { JobWorkerService } from './job-worker.service';
import { TijarahQueueService } from './tijarah-queue.service';
import { CreateWhatsAppDocumentJobDto } from './dto/create-job.dto';
import { buildCaption } from './caption';
import { WhatsAppDocumentJob } from './entities/whatsapp-document-job.entity';
import { WHATSAPP_DELIVERY_PROVIDER, type WhatsAppDeliveryProvider } from './providers/whatsapp-delivery.provider';
import type { JobStatus } from './job-status';

/**
 * The Phase 1 surface: create a job, watch it, and steer it if it goes wrong.
 *
 * Creating a job needs OPERATOR; reading needs VIEWER. Nothing here sends a WhatsApp message.
 * That separation is the design: the button, the agent and this controller all only ever
 * write a row, and the worker is the single thing that talks to WhatsApp. It means there is
 * exactly one place where a document can leave the building.
 */
@ApiTags('WhatsApp Document Jobs')
@Controller('whatsapp-document-jobs')
export class WhatsAppJobsController {
  constructor(
    private readonly service: WhatsAppJobsService,
    private readonly kpis: JobKpiService,
    private readonly worker: JobWorkerService,
    private readonly hostQueue: TijarahQueueService,
    @Inject(WHATSAPP_DELIVERY_PROVIDER) private readonly whatsapp: WhatsAppDeliveryProvider,
  ) {}

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a document-delivery job' })
  async create(
    @Body() dto: CreateWhatsAppDocumentJobDto,
    @CurrentApiKey() key: ApiKey,
  ): Promise<Record<string, unknown>> {
    // The authenticated key is recorded when the caller did not name a user, so every job
    // traces back to someone even when it arrived from a script.
    const job = await this.service.create({ ...dto, requestedByUserId: dto.requestedByUserId ?? key?.id });
    return {
      success: true,
      jobId: job.reference,
      status: job.status,
      message: 'WhatsApp document-delivery job created successfully.',
    };
  }

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List jobs, newest first' })
  async list(
    @Query('status') status?: JobStatus,
    @Query('documentType') documentType?: string,
    @Query('clientId') clientId?: string,
    @Query('limit') limit?: string,
  ): Promise<WhatsAppDocumentJob[]> {
    return this.service.list({ status, documentType, clientId, limit: Number(limit) || undefined });
  }

  /** The registry, for the send form's document-type picker. */
  @Get('document-types')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Document types this system can deliver' })
  async documentTypes(): Promise<Record<string, unknown>[]> {
    const types = await this.service.listDocumentTypes(true);
    return types.map(t => ({
      documentType: t.documentType,
      displayName: t.displayName,
      requiredParameters: t.requiredParameters ?? [],
      optionalParameters: t.optionalParameters ?? [],
      expectedMimeType: t.expectedMimeType,
      enabled: t.enabled,
      targetProcessingSeconds: t.targetProcessingSeconds,
      // endpoint and authProfile are deliberately omitted: the picker does not need the
      // integration's shape, and this response is read by a browser.
    }));
  }

  @Get('kpis')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Per-document-type KPIs and SLA compliance' })
  async kpi(): Promise<DocumentTypeKpi[]> {
    return this.kpis.byDocumentType();
  }

  /** Everything the §11 connection screen shows, in one call. */
  @Get('connection')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'WhatsApp connection state, queue depth and last delivery' })
  async connection(): Promise<Record<string, unknown>> {
    const sessionId = this.worker.config.sessionId;
    const [state, counts, last] = await Promise.all([
      this.whatsapp.getConnectionStatus(sessionId).catch(() => 'ERROR' as const),
      this.service.counts(),
      this.service.lastSent(),
    ]);
    return {
      provider: this.whatsapp.id,
      sessionId,
      // Only ever what the provider reports. §11: never claim Connected on inference.
      state,
      workerEnabled: this.worker.config.enabled,
      pollIntervalSeconds: this.worker.config.pollIntervalSeconds,
      pendingJobs: counts.pending,
      failedJobs: counts.failed,
      sentJobs: counts.sent,
      lastSuccessfulDelivery: last
        ? {
            jobId: last.reference,
            documentName: last.documentName,
            sentAt: last.sentAt,
            whatsappMessageId: last.whatsappMessageId,
          }
        : null,
    };
  }

  @Get('connection/qr')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'QR code for pairing, when one is being shown' })
  async qr(): Promise<{ qr: string | null; state: string }> {
    const sessionId = this.worker.config.sessionId;
    const [qr, state] = await Promise.all([
      this.whatsapp.getQRCode(sessionId).catch(() => null),
      this.whatsapp.getConnectionStatus(sessionId).catch(() => 'ERROR' as const),
    ]);
    return { qr, state };
  }

  /**
   * Queues a test document addressed to the connected number itself.
   *
   * Self-addressed, and that is not a convenience — it is the safety property. Any other
   * recipient for an on-demand "does this work?" button is a real person who did not ask to
   * be part of someone's connection check, and a number typed into a test field is one
   * mistake away from being a customer's.
   *
   * It goes through the ordinary job pipeline rather than sending directly, so what it proves
   * is the thing that actually runs in production: registry lookup, document API, validation,
   * transport, and a row on the jobs screen with a timeline like any other.
   */
  @Post('connection/test-document')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Send a test document to the connected number itself' })
  async testDocument(): Promise<Record<string, unknown>> {
    const sessionId = this.worker.config.sessionId;
    const state = await this.whatsapp.getConnectionStatus(sessionId).catch(() => 'ERROR' as const);
    if (state !== 'CONNECTED') {
      return { queued: false, state, message: `WhatsApp is ${state}. Connect and scan before sending a test.` };
    }

    const own = await this.whatsapp.getConnectedNumber(sessionId);
    if (!own) {
      return {
        queued: false,
        state,
        message: 'The connected number could not be read, so there is nowhere safe to send a test.',
      };
    }

    const types = await this.service.listDocumentTypes(false);
    const type = types[0];
    if (!type) return { queued: false, state, message: 'No document type is enabled.' };

    const reference = `TEST-${Date.now().toString().slice(-6)}`;
    const parameters: Record<string, unknown> = {};
    for (const key of type.requiredParameters ?? []) parameters[key] = reference;

    const job = await this.service.create({
      source: 'ui',
      documentType: type.documentType,
      documentName: `${reference}.pdf`,
      documentReference: reference,
      recipientName: 'This device',
      recipientWhatsAppNumber: own,
      /*
       * The caption names the document and nothing else.
       *
       * A document sent to a customer is from the business, not from a bot, and a line saying
       * otherwise is the one part of the message a recipient actually reads. Even this test —
       * which only ever goes to the connected number — carries no system wording, so the
       * caption a customer sees is never accidentally the one written for an operator.
       */
      messageText: buildCaption(
        type.documentType,
        { displayName: type.displayName, documentNumber: reference, reference },
        type.captionTemplate,
      ),
      parameters,
      // Time-stamped, so pressing the button twice is two tests rather than a refused duplicate.
      idempotencyKey: `test-${type.documentType}-${own}-${reference}`,
    });
    return { queued: true, jobId: job.reference, to: own, state };
  }

  // Declared BEFORE `connection/:action`, which is a parameterised route on the same prefix and
  // matches "connection/test-document" first if it comes earlier — its default branch returned a
  // bare status object, so this endpoint appeared to work and quietly did nothing.
  @Post('connection/:action')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'connect | reconnect | logout' })
  async connectionAction(@Param('action') action: string): Promise<{ state: string }> {
    const sessionId = this.worker.config.sessionId;
    switch (action) {
      case 'connect':
        return { state: await this.whatsapp.connect(sessionId) };
      case 'reconnect':
        return { state: await this.whatsapp.reconnect(sessionId) };
      case 'logout':
        await this.whatsapp.logout(sessionId);
        return { state: 'DISCONNECTED' };
      default:
        return { state: await this.whatsapp.getConnectionStatus(sessionId) };
    }
  }

  /**
   * Runs one worker pass now.
   *
   * For demonstrations and for a stuck queue an operator wants moving. It claims and processes
   * exactly as the timer would — there is no separate path — so what it shows is what the
   * background worker does.
   */
  @Post('worker/tick')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Run one worker pass immediately' })
  async tick(): Promise<{ claimed: number }> {
    return { claimed: await this.worker.tick() };
  }

  /**
   * Pulls from the host's queue now, and acknowledges anything already delivered.
   *
   * Same code path as the timer, so what it does is what runs unattended.
   */
  @Post('host-queue/sync')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Import pending host-queue rows and acknowledge delivered ones' })
  async syncHostQueue(): Promise<Record<string, unknown>> {
    const result = await this.hostQueue.tick();
    return { ...result, enabled: this.hostQueue.config.enabled, source: this.hostQueue.config.baseUrl };
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'One job, with its full timeline' })
  async findOne(@Param('id') id: string): Promise<WhatsAppDocumentJob> {
    return this.service.findByReference(id);
  }

  @Post(':id/retry')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Return a failed job to the queue' })
  async retry(@Param('id') id: string): Promise<Record<string, unknown>> {
    const job = await this.service.retry(id);
    return { success: true, jobId: job.reference, status: job.status };
  }

  @Post(':id/cancel')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Cancel a job that has not been sent' })
  async cancel(@Param('id') id: string): Promise<Record<string, unknown>> {
    const job = await this.service.cancel(id);
    return { success: true, jobId: job.reference, status: job.status };
  }
}
