import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsHexColor,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

/** Roles an agent record can carry. Mirrors the API-key role vocabulary. */
export enum AgentRole {
  ADMIN = 'admin',
  OPERATOR = 'operator',
  VIEWER = 'viewer',
}

export class CreateAgentDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 190 })
  @IsOptional()
  @IsEmail()
  @MaxLength(190)
  email?: string;

  @ApiPropertyOptional({
    description: 'Id of the API key this agent signs in with. Links the key to a person so "Mine" and claim work.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  apiKeyId?: string;

  @ApiPropertyOptional({ enum: AgentRole, default: AgentRole.OPERATOR })
  @IsOptional()
  @IsEnum(AgentRole)
  role?: AgentRole;

  @ApiPropertyOptional({ description: 'Avatar tint, as a hex colour', example: '#25d366' })
  @IsOptional()
  @IsHexColor()
  color?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  active?: boolean;
}

export class UpdateAgentDto extends CreateAgentDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare name: string;
}

export class CreateTeamDto {
  @ApiProperty({ maxLength: 100 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 240 })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional({ example: '#2563eb' })
  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class UpdateTeamDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ maxLength: 240 })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class AddTeamMemberDto {
  @ApiProperty()
  @IsUUID()
  agentId!: string;

  @ApiPropertyOptional({ enum: ['lead', 'member'], default: 'member' })
  @IsOptional()
  @IsEnum(['lead', 'member'])
  teamRole?: 'lead' | 'member';
}

export class CreateTagDto {
  @ApiProperty({ maxLength: 60 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: '#6366f1' })
  @IsOptional()
  @IsHexColor()
  color?: string;
}

export class UpdateTagDto {
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  color?: string;
}

/** Quick-reply bodies are message text, so they share the message length ceiling. */
export const QUICK_REPLY_BODY_MAX = 4096;

export class CreateQuickReplyDto {
  @ApiProperty({ description: 'Shortcut typed after "/" in the composer', example: 'price', maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(41)
  shortcut!: string;

  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title!: string;

  @ApiProperty({
    description: 'Reply text. Supports {{name}}, {{phone}} and {{agent_name}} placeholders.',
    maxLength: QUICK_REPLY_BODY_MAX,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(QUICK_REPLY_BODY_MAX)
  body!: string;

  @ApiPropertyOptional({ default: 'General', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folder?: string;
}

export class UpdateQuickReplyDto {
  @ApiPropertyOptional({ maxLength: 41 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(41)
  shortcut?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional({ maxLength: QUICK_REPLY_BODY_MAX })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(QUICK_REPLY_BODY_MAX)
  body?: string;

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  folder?: string;
}

export class RenderQuickReplyDto {
  @ApiPropertyOptional({ description: 'Conversation the reply is being inserted into, used to fill placeholders' })
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
