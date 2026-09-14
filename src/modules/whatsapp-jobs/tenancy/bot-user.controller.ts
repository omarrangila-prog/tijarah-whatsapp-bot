import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Put,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireRole } from '../../auth/decorators/auth.decorators';
import { ApiKeyRole } from '../../auth/entities/api-key.entity';
import { BotUserService } from './bot-user.service';
import { UpsertBotUserDto } from './bot-user.dto';
import { normalizeWhatsAppNumber } from '../providers/whatsapp-delivery.provider';
import type { BotUser } from './bot-user.entity';

/**
 * Who the bot is allowed to serve, and as which company.
 *
 * A number that is not here gets the registration message and nothing else (with
 * `BOT_REQUIRE_REGISTRATION=true`). Removal deactivates rather than deletes: the row is the
 * record of which company a phone was ever mapped to, and an audit of "why did this person
 * receive that ledger" needs it after the mapping is gone.
 */
@ApiTags('Bot Users')
@Controller('bot-users')
export class BotUserController {
  constructor(private readonly users: BotUserService) {}

  @Get()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'List the WhatsApp numbers registered with the bot and their company' })
  async list(): Promise<BotUser[]> {
    return this.users.list();
  }

  @Put()
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Register a WhatsApp number as a Tijarah user (or update its company)' })
  async upsert(@Body() dto: UpsertBotUserDto): Promise<BotUser> {
    const saved = await this.users.upsert(dto);
    if (!saved) throw new UnprocessableEntityException(`"${dto.whatsAppNo}" is not a usable WhatsApp number`);
    return saved;
  }

  @Delete(':phone')
  @RequireRole(ApiKeyRole.ADMIN)
  @ApiOperation({ summary: 'Stop serving a WhatsApp number (the row is kept, deactivated)' })
  async deactivate(@Param('phone') phone: string): Promise<{ whatsAppNo: string; isActive: false }> {
    const whatsAppNo = normalizeWhatsAppNumber(phone);
    if (!whatsAppNo || !(await this.users.deactivate(whatsAppNo))) {
      throw new NotFoundException(`No bot user with number ${phone}`);
    }
    return { whatsAppNo, isActive: false };
  }
}
