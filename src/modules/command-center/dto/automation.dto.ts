import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { FlowTrigger } from '../entities/automation-flow.entity';

/** Ceiling on rule size — a flow nobody can read is a flow nobody can debug. */
export const MAX_CONDITIONS = 10;
export const MAX_ACTIONS = 10;

export class FlowConditionDto {
  @ApiProperty({
    enum: [
      'body',
      'sessionId',
      'chatKind',
      'contactTag',
      'businessHours',
      'conversationStatus',
      'conversationPriority',
    ],
  })
  @IsEnum([
    'body',
    'sessionId',
    'chatKind',
    'contactTag',
    'businessHours',
    'conversationStatus',
    'conversationPriority',
  ])
  field!:
    'body' | 'sessionId' | 'chatKind' | 'contactTag' | 'businessHours' | 'conversationStatus' | 'conversationPriority';

  @ApiProperty({ enum: ['contains', 'equals', 'startsWith', 'notContains', 'is', 'isNot'] })
  @IsEnum(['contains', 'equals', 'startsWith', 'notContains', 'is', 'isNot'])
  operator!: 'contains' | 'equals' | 'startsWith' | 'notContains' | 'is' | 'isNot';

  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MaxLength(200)
  value!: string;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  caseSensitive?: boolean;
}

export class FlowActionDto {
  @ApiProperty({
    enum: [
      'send_reply',
      'add_tag',
      'remove_tag',
      'assign_agent',
      'assign_team',
      'set_priority',
      'set_status',
      'create_follow_up',
      'webhook',
    ],
  })
  @IsEnum([
    'send_reply',
    'add_tag',
    'remove_tag',
    'assign_agent',
    'assign_team',
    'set_priority',
    'set_status',
    'create_follow_up',
    'webhook',
  ])
  type!:
    | 'send_reply'
    | 'add_tag'
    | 'remove_tag'
    | 'assign_agent'
    | 'assign_team'
    | 'set_priority'
    | 'set_status'
    | 'create_follow_up'
    | 'webhook';

  @ApiPropertyOptional({ description: 'Action payload: tag name, agent/team id, priority, status, or reply text' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  value?: string;

  @ApiPropertyOptional({
    description: 'For send_reply: use an approved quick reply instead of free text (preferred).',
  })
  @IsOptional()
  @IsUUID()
  quickReplyId?: string;

  @ApiPropertyOptional({ description: 'For create_follow_up: how far ahead the reminder is due.', minimum: 1 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(60 * 24 * 30)
  dueInMinutes?: number;

  @ApiPropertyOptional({ description: 'For webhook: the endpoint to POST to.' })
  @IsOptional()
  @IsUrl({ require_tld: false, protocols: ['http', 'https'] })
  @MaxLength(2048)
  url?: string;
}

export class CreateFlowDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 240 })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional({ description: 'Restrict to one number. Omit to apply to every number.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @ApiPropertyOptional({ enum: FlowTrigger, default: FlowTrigger.MESSAGE_RECEIVED })
  @IsOptional()
  @IsEnum(FlowTrigger)
  trigger?: FlowTrigger;

  @ApiPropertyOptional({ description: 'For the conversation_unresolved trigger: how long unresolved before firing.' })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  triggerAfterMinutes?: number;

  @ApiPropertyOptional({ type: [FlowConditionDto], description: 'ALL must match. Empty matches every message.' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_CONDITIONS)
  @ValidateNested({ each: true })
  @Type(() => FlowConditionDto)
  conditions?: FlowConditionDto[];

  @ApiProperty({ type: [FlowActionDto] })
  @IsArray()
  @ArrayMaxSize(MAX_ACTIONS)
  @ValidateNested({ each: true })
  @Type(() => FlowActionDto)
  actions!: FlowActionDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description: 'Quiet period per conversation, in seconds. This is the loop guard — lower it knowingly.',
    default: 300,
    minimum: 0,
    maximum: 86400,
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(86400)
  cooldownSeconds?: number;
}

export class UpdateFlowDto extends CreateFlowDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare name: string;

  @ApiPropertyOptional({ type: [FlowActionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_ACTIONS)
  @ValidateNested({ each: true })
  @Type(() => FlowActionDto)
  declare actions: FlowActionDto[];
}
