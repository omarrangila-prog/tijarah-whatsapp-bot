import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { CurrentApiKey, RequireRole, RequireUnscopedKey } from '../auth/decorators/auth.decorators';
import { ApiKey, ApiKeyRole } from '../auth/entities/api-key.entity';
import { CustomerService, sanitizeCustomFields } from './customer.service';
import { AgentService } from './agent.service';
import { ListCustomersQueryDto, SetConsentDto, UpdateCustomerDto } from './dto/customer.dto';

/**
 * Customer 360.
 *
 * `@RequireUnscopedKey()`: a customer profile spans every number the person has ever messaged, so
 * it has no single session to fence against. A key confined to one number must not be able to
 * enumerate the whole customer book, and there is no correct partial answer to give it.
 */
@ApiTags('Command Center — Customers')
@RequireUnscopedKey()
@Controller('customers')
export class CustomerController {
  constructor(
    private readonly customers: CustomerService,
    private readonly agents: AgentService,
  ) {}

  @Get()
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiOperation({ summary: 'Search the customer book' })
  list(@Query() query: ListCustomersQueryDto) {
    return this.customers.list(query);
  }

  @Get(':waId')
  @RequireRole(ApiKeyRole.VIEWER)
  @ApiParam({ name: 'waId', description: 'WhatsApp id, e.g. 923001234567@c.us' })
  @ApiOperation({ summary: 'Get one customer, with derived interaction facts' })
  get(@Param('waId') waId: string) {
    return this.customers.getByWaId(decodeURIComponent(waId));
  }

  @Patch(':waId')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({ summary: 'Update the business fields on a customer profile' })
  update(@Param('waId') waId: string, @Body() dto: UpdateCustomerDto) {
    // Custom fields arrive as an open object, so they are sanitized here rather than trusted from
    // the DTO — `@IsObject()` can say it is an object, not that its values are storable strings.
    return this.customers.update(decodeURIComponent(waId), {
      ...dto,
      ...(dto.customFields !== undefined ? { customFields: sanitizeCustomFields(dto.customFields) } : {}),
    });
  }

  @Post(':waId/consent')
  @RequireRole(ApiKeyRole.OPERATOR)
  @ApiOperation({
    summary: 'Record a marketing consent decision. Opting in requires a stated source.',
  })
  async setConsent(@Param('waId') waId: string, @Body() dto: SetConsentDto, @CurrentApiKey() apiKey?: ApiKey) {
    const actor = await this.agents.resolveActor(apiKey);
    return this.customers.setConsent(decodeURIComponent(waId), dto.status, {
      source: dto.source,
      recordedBy: actor?.name ?? apiKey?.name ?? null,
    });
  }
}
