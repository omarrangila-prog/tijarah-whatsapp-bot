import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { AutomationFlowService } from './automation-flow.service';
import { CreateFlowDto, UpdateFlowDto } from './dto/automation.dto';

/**
 * The WHEN → IF → THEN builder.
 *
 * `@RequireUnscopedKey()`: a flow can be written to apply to EVERY number (`sessionId` null), so a
 * session-restricted key that could create one would reach outside its own fence — the classic
 * shape this decorator exists for. Reads are fenced the same way for symmetry: a scoped key has no
 * business enumerating rules that act on numbers it cannot see.
 */
@ApiTags('Command Center — Automation')
@RequireUnscopedKey()
@Controller('automation-flows')
export class AutomationFlowController {
  constructor(private readonly flows: AutomationFlowService) {}

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'List automation flows' })
  list(@CurrentApiKey() apiKey?: ApiKey, @Query('sessionId') sessionId?: string) {
    // Scoped to the calling key as well as fenced by @RequireUnscopedKey: the query param is not a
    // route param, so the guard cannot narrow on it, and a filter that widened past the key's
    // allowlist would be exactly the leak the class-level fence is there to prevent.
    return this.flows.list(sessionId, apiKey?.allowedSessions);
  }

  @Get('executions')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Recent flow executions, including skips and failures with their reasons' })
  executions(@CurrentApiKey() apiKey?: ApiKey, @Query('flowId') flowId?: string, @Query('limit') limit?: string) {
    return this.flows.listExecutions(
      { flowId, limit: limit ? parseInt(limit, 10) : undefined },
      apiKey?.allowedSessions,
    );
  }

  @Get(':id')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Get one flow' })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.flows.get(id);
  }

  @Post()
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Create a flow' })
  create(@Body() dto: CreateFlowDto) {
    return this.flows.create(dto);
  }

  @Patch(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update a flow' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFlowDto) {
    return this.flows.update(id, dto);
  }

  @Delete(':id')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Delete a flow' })
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.flows.remove(id);
    return { success: true };
  }
}
