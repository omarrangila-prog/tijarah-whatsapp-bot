import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { BroadcastService } from './broadcast.service';
import { AgentService } from './agent.service';
import {
  CreateBroadcastDto,
  ListRecipientsQueryDto,
  PreviewAudienceDto,
  UpdateBroadcastDto,
} from './dto/broadcast.dto';

/**
 * Broadcast campaigns.
 *
 * `@RequireUnscopedKey()`: a campaign names its sending number in the request BODY, which the
 * guard's route-param fence cannot see, and its audience is drawn from the whole customer book. A
 * scoped key must not be able to send from a number it does not hold.
 *
 * Approval is a separate ADMIN-only call from creation on purpose — drafting a campaign and
 * authorising it to actually reach customers are different acts and should need different rights.
 */
@ApiTags('Command Center — Broadcasts')
@RequireUnscopedKey()
@Controller('broadcasts')
export class BroadcastController {
  constructor(
    private readonly broadcasts: BroadcastService,
    private readonly agents: AgentService,
  ) {}

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List campaigns' })
  list() {
    return this.broadcasts.list();
  }

  @Post('audience-preview')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Resolve an audience before committing to it',
    description:
      'Returns how many contacts matched and how many of those have opted in. Only opted-in contacts are ever messaged.',
  })
  previewAudience(@Body() dto: PreviewAudienceDto) {
    return this.broadcasts.previewAudience(dto.audience ?? null);
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get one campaign' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.get(id);
  }

  @Get(':id/recipients')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Per-recipient delivery state, including failures and consent skips' })
  recipients(@Param('id', ParseUUIDPipe) id: string, @Query() query: ListRecipientsQueryDto) {
    return this.broadcasts.listRecipients(id, query.status);
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a draft campaign' })
  create(@Body() dto: CreateBroadcastDto) {
    // `scheduledAt` is destructured out rather than spread over: the DTO carries an ISO string and
    // the entity a Date, so spreading the DTO first would leave the string on the object under a
    // Date-typed key for whichever branch does not overwrite it.
    const { scheduledAt, ...rest } = dto;
    return this.broadcasts.create({ ...rest, scheduledAt: scheduledAt ? new Date(scheduledAt) : null });
  }

  @Patch(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Edit a draft or pending campaign' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateBroadcastDto) {
    const { scheduledAt, ...rest } = dto;
    return this.broadcasts.update(id, {
      ...rest,
      ...(scheduledAt !== undefined ? { scheduledAt: scheduledAt ? new Date(scheduledAt) : null } : {}),
    });
  }

  @Post(':id/submit')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Lock the campaign and send it for approval. Nothing is sent yet.' })
  submit(@Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.submitForApproval(id);
  }

  @Post(':id/approve')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Approve a campaign: build the consented recipient list and start sending' })
  @ApiResponse({ status: 400, description: 'No opted-in contacts match the audience' })
  async approve(@Param('id', ParseUUIDPipe) id: string, @CurrentApiKey() apiKey?: ApiKey) {
    const actor = await this.agents.resolveActor(apiKey);
    return this.broadcasts.approve(id, actor?.name ?? apiKey?.name ?? null);
  }

  @Post(':id/pause')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Pause a sending campaign' })
  pause(@Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.pause(id);
  }

  @Post(':id/resume')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Resume a paused campaign' })
  resume(@Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.resume(id);
  }

  @Post(':id/cancel')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Cancel a campaign' })
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.broadcasts.cancel(id);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a campaign and its recipient rows' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.broadcasts.remove(id);
    return { success: true };
  }
}
