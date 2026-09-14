import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { ConversationPriority, ConversationStatus } from '../entities/conversation.entity';

/** Longest note body. Generous — a note is where an agent writes what actually happened. */
export const NOTE_MAX_LENGTH = 5000;

/** Split a repeated or comma-joined query parameter into a trimmed list. */
const toStringArray = ({ value }: { value: unknown }): string[] | undefined => {
  if (value === undefined || value === null || value === '') return undefined;
  // A repeated query param arrives as an array, a comma-joined one as a string. Anything else
  // (an object, from a malformed nested query) is not a filter value and is dropped rather than
  // stringified into "[object Object]".
  if (typeof value !== 'string' && !Array.isArray(value)) return undefined;
  const parts = Array.isArray(value) ? value : value.split(',');
  const cleaned = parts.map(part => String(part).trim()).filter(Boolean);
  return cleaned.length ? cleaned : undefined;
};

export class ListConversationsQueryDto {
  @ApiPropertyOptional({ description: 'Restrict to these session ids (comma-separated or repeated)' })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  sessionIds?: string[];

  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional({ enum: ConversationPriority })
  @IsOptional()
  @IsEnum(ConversationPriority)
  priority?: ConversationPriority;

  @ApiPropertyOptional({
    description: 'Agent id, the literal "unassigned", or "me" to resolve against the calling API key',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Team id' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  teamId?: string;

  @ApiPropertyOptional({
    description: 'Tag ids (comma-separated or repeated). A conversation matching any is included.',
  })
  @IsOptional()
  @Transform(toStringArray)
  @IsArray()
  @IsString({ each: true })
  tagIds?: string[];

  @ApiPropertyOptional({ description: 'Only conversations with unread messages' })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  unreadOnly?: boolean;

  @ApiPropertyOptional({ description: 'Only starred conversations' })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  starredOnly?: boolean;

  @ApiPropertyOptional({ description: 'Match contact name, phone number, or message content' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ description: 'Lower bound on last activity (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Upper bound on last activity (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ default: 25, minimum: 1, maximum: 100 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  offset?: number;
}

export class UpdateConversationStatusDto {
  @ApiProperty({ enum: ConversationStatus })
  @IsEnum(ConversationStatus)
  status!: ConversationStatus;
}

export class UpdateConversationPriorityDto {
  @ApiProperty({ enum: ConversationPriority })
  @IsEnum(ConversationPriority)
  priority!: ConversationPriority;
}

export class UpdateConversationFlagsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  starred?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  muted?: boolean;
}

export class AssignConversationDto {
  @ApiPropertyOptional({ description: 'Agent id to assign to. Send null to unassign.', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  agentId?: string | null;

  @ApiPropertyOptional({ description: 'Team id to route to. Send null to clear.', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  teamId?: string | null;

  @ApiPropertyOptional({ description: 'Why the assignment changed — recorded in the history trail.' })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  reason?: string;
}

export class CreateNoteDto {
  @ApiProperty({ description: 'Internal note body. Never sent to WhatsApp.', maxLength: NOTE_MAX_LENGTH })
  @IsString()
  @IsNotEmpty()
  @MaxLength(NOTE_MAX_LENGTH)
  body!: string;
}

export class AddConversationTagDto {
  @ApiProperty({ description: 'Tag id to attach' })
  @IsUUID()
  tagId!: string;
}

export class TransferConversationDto {
  @ApiProperty({ description: 'Agent taking the conversation over.' })
  @IsUUID()
  toAgentId!: string;

  @ApiPropertyOptional({ description: 'Route to this team as well. Send null to clear.', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  toTeamId?: string | null;

  @ApiPropertyOptional({
    description:
      'What the incoming agent needs to know. Recorded on the assignment trail AND written into the ' +
      'conversation notes, because those are read by different people in different places.',
    maxLength: NOTE_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX_LENGTH)
  note?: string;
}
