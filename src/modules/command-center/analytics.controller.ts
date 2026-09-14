import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsEnum, IsISO8601, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { CurrentApiKey, RequireRole } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { Session } from '../session/entities/session.entity';
import { resolveSessionScope } from '../../common/security/session-scope';
import { AnalyticsService, type AnalyticsRange } from './analytics.service';
import { ConversationService } from './conversation.service';
import { CustomerService } from './customer.service';
import { normalizeWaId } from './conversation-state';

export class AnalyticsQueryDto {
  @ApiPropertyOptional({ enum: ['today', '7d', '30d', 'custom'], default: '7d' })
  @IsOptional()
  @IsEnum(['today', '7d', '30d', 'custom'])
  range?: AnalyticsRange;

  @ApiPropertyOptional({ description: 'Start of a custom range (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'End of a custom range (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ description: 'Restrict to these sessions (comma-separated or repeated)' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === undefined || value === null || value === '') return undefined;
    // A repeated query param arrives as an array, a comma-joined one as a string. Anything else
    // (an object, from a malformed nested query) is not a filter value and is dropped rather than
    // stringified into "[object Object]".
    if (typeof value !== 'string' && !Array.isArray(value)) return undefined;
    const parts = Array.isArray(value) ? value : value.split(',');
    const cleaned = parts.map(part => String(part).trim()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  })
  @IsArray()
  @IsString({ each: true })
  sessionIds?: string[];
}

/**
 * Overview and analytics.
 *
 * Global routes with no `:sessionId` segment, so — like `session.controller.ts :: getStats` — each
 * handler applies the calling key's `allowedSessions` itself before any aggregate is computed:
 * `resolveSessionScope` narrows a requested session list within the fence and never past it, and an
 * out-of-scope request resolves to an empty set, which yields zeroes rather than another tenant's
 * numbers. Registered with that reason in `global-route-fence-coverage.spec.ts`.
 */
@ApiTags('Command Center — Analytics')
@Controller('command-center')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly conversations: ConversationService,
    private readonly customers: CustomerService,
    @InjectRepository(Session, 'data') private readonly sessions: Repository<Session>,
  ) {}

  @Get('analytics')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'KPIs, time series, workload and peak hours for the selected window' })
  async analyticsReport(@Query() query: AnalyticsQueryDto, @CurrentApiKey() apiKey?: ApiKey) {
    const visible = await this.visibleSessions(apiKey, query.sessionIds);
    return this.analytics.compute({ ...query, sessionIds: visible.map(s => s.id) }, visible);
  }

  @Post('backfill')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Build conversations from message history',
    description:
      'Seeds the inbox index from messages already stored, so a gateway that ran before the command ' +
      'center existed shows its history. Idempotent, and never overwrites workflow state an operator has set.',
  })
  async backfill(@Body() body: { sessionIds?: string[] }, @CurrentApiKey() apiKey?: ApiKey) {
    const visible = await this.visibleSessions(apiKey, body?.sessionIds);
    const result = await this.conversations.backfill(visible.map(s => s.id));

    // Seed the customer book from the same walk, so Contacts and broadcast audiences are populated
    // by history rather than only by traffic that arrives after the command center was installed.
    // Each touch is independent; one bad row must not abort the rest of the backfill.
    let contacts = 0;
    for (const contact of result.contacts) {
      try {
        const waId = normalizeWaId(contact.chatId);
        if (!waId.endsWith('@c.us')) continue;
        await this.customers.touch(waId, contact.firstAt, contact.name);
        await this.customers.touch(waId, contact.lastAt, contact.name);
        contacts += 1;
      } catch {
        // Skip and keep going — a profile that cannot be seeded is recoverable on the next message.
      }
    }
    return { created: result.created, updated: result.updated, contacts };
  }

  /**
   * The sessions this key may report on: its `allowedSessions` fence, optionally narrowed by the
   * request. An empty result means the request asked only for sessions outside the fence.
   */
  private async visibleSessions(
    apiKey: ApiKey | undefined,
    requested: string[] | undefined,
  ): Promise<Array<{ id: string; name: string; status: string }>> {
    const scope = resolveSessionScope(apiKey?.allowedSessions);
    const rows = await this.sessions.find({
      where: scope ? { id: In(scope) } : {},
      select: { id: true, name: true, status: true },
      order: { name: 'ASC' },
    });
    const narrowed = requested?.length ? rows.filter(row => requested.includes(row.id)) : rows;
    return narrowed.map(row => ({ id: row.id, name: row.name, status: String(row.status) }));
  }
}
