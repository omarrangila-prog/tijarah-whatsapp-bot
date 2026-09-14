import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ToStrictBoolean } from '../../../common/utils/strict-boolean';

export const AI_DRAFT_MAX = 4096;

export class AnalyzeConversationDto {
  @ApiPropertyOptional({ description: 'Skip the cache and re-analyze even if the conversation has not moved.' })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  force?: boolean;
}

export class SuggestReplyDto {
  @ApiPropertyOptional({
    description: 'Extra steer for the draft, e.g. "offer a 10% discount". The draft is never sent automatically.',
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instruction?: string;
}

export class TransformDraftDto {
  @ApiProperty({ description: 'The agent’s own draft to transform.', maxLength: AI_DRAFT_MAX })
  @IsString()
  @IsNotEmpty()
  @MaxLength(AI_DRAFT_MAX)
  text!: string;
}

export class TranslateDraftDto extends TransformDraftDto {
  @ApiProperty({ description: 'Target language, as a person would name it.', example: 'Spanish', maxLength: 40 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  targetLanguage!: string;
}
