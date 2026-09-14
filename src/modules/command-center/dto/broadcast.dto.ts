import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import { ToStrictNumber } from '../../../common/utils/strict-boolean';
import { BroadcastRecipientStatus } from '../entities/broadcast-recipient.entity';

/** Same floor the service enforces; declared here so the API documents it too. */
export const MIN_BROADCAST_THROTTLE_MS = 1500;
export const BROADCAST_BODY_MAX = 4096;

export class BroadcastAudienceDto {
  @ApiPropertyOptional({ description: 'Contacts whose conversations carry any of these tags' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsUUID('4', { each: true })
  tagIds?: string[];

  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  customerType?: string;

  @ApiPropertyOptional({ maxLength: 90 })
  @IsOptional()
  @IsString()
  @MaxLength(90)
  city?: string;

  @ApiPropertyOptional({ description: 'Contacts who have talked to these numbers' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  sessionIds?: string[];
}

export class CreateBroadcastDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiProperty({ description: 'The number the campaign sends from' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  sessionId!: string;

  @ApiProperty({
    description: 'Message body. Supports {{name}} and {{phone}}.',
    maxLength: BROADCAST_BODY_MAX,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(BROADCAST_BODY_MAX)
  body!: string;

  @ApiPropertyOptional({ type: BroadcastAudienceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BroadcastAudienceDto)
  audience?: BroadcastAudienceDto;

  @ApiPropertyOptional({
    description: 'Gap between sends in milliseconds. Values below the floor are raised to it.',
    default: 3000,
    minimum: MIN_BROADCAST_THROTTLE_MS,
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(MIN_BROADCAST_THROTTLE_MS)
  @Max(600000)
  throttleMs?: number;

  @ApiPropertyOptional({ description: 'Start at this time instead of on approval (ISO 8601)' })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}

export class UpdateBroadcastDto extends CreateBroadcastDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  declare name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  declare sessionId: string;

  @ApiPropertyOptional({ maxLength: BROADCAST_BODY_MAX })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(BROADCAST_BODY_MAX)
  declare body: string;
}

export class PreviewAudienceDto {
  @ApiPropertyOptional({ type: BroadcastAudienceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BroadcastAudienceDto)
  audience?: BroadcastAudienceDto;
}

export class ListRecipientsQueryDto {
  @ApiPropertyOptional({ enum: BroadcastRecipientStatus })
  @IsOptional()
  @IsEnum(BroadcastRecipientStatus)
  status?: BroadcastRecipientStatus;
}
