import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { FollowUpStatus } from '../entities/follow-up.entity';
import { ScheduledMessageStatus } from '../entities/scheduled-message.entity';

export class CreateFollowUpDto {
  @ApiPropertyOptional({ description: 'Conversation this follow-up belongs to' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  @ApiPropertyOptional({ description: 'Agent responsible' })
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiProperty({ maxLength: 190 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(190)
  title!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiProperty({ description: 'When it is due (ISO 8601)' })
  @IsISO8601()
  dueAt!: string;
}

export class UpdateFollowUpStatusDto {
  @ApiProperty({ enum: FollowUpStatus })
  @IsEnum(FollowUpStatus)
  status!: FollowUpStatus;
}

export class ListFollowUpsQueryDto {
  @ApiPropertyOptional({ enum: FollowUpStatus })
  @IsOptional()
  @IsEnum(FollowUpStatus)
  status?: FollowUpStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  assigneeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}

export class CreateScheduledMessageDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sessionId!: string;

  @ApiProperty({ description: 'Chat JID to send to' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(190)
  chatId!: string;

  @ApiProperty({ maxLength: 4096 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  body!: string;

  @ApiProperty({ description: 'When to send it (ISO 8601). A past time is rejected.' })
  @IsISO8601()
  runAt!: string;
}

export class ListScheduledMessagesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  sessionId?: string;

  @ApiPropertyOptional({ enum: ScheduledMessageStatus })
  @IsOptional()
  @IsEnum(ScheduledMessageStatus)
  status?: ScheduledMessageStatus;
}
