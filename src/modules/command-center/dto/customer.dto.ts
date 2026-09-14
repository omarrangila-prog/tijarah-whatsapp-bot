import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ToStrictNumber } from '../../../common/utils/strict-boolean';
import { ConsentStatus } from '../entities/contact-consent.entity';

export class ListCustomersQueryDto {
  @ApiPropertyOptional({ description: 'Match name, company, email, phone or WhatsApp id' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ description: 'Segment filter, e.g. "lead" or "vip"' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  customerType?: string;

  @ApiPropertyOptional({ enum: ConsentStatus })
  @IsOptional()
  @IsEnum(ConsentStatus)
  consent?: ConsentStatus;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  offset?: number;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional({ description: 'Operator override for the contact name', maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  company?: string;

  @ApiPropertyOptional({ maxLength: 190 })
  @IsOptional()
  @IsEmail()
  @MaxLength(190)
  email?: string;

  @ApiPropertyOptional({ description: 'Where this customer came from', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  source?: string;

  @ApiPropertyOptional({ description: 'Segment used by broadcast audiences', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  customerType?: string;

  @ApiPropertyOptional({ maxLength: 90 })
  @IsOptional()
  @IsString()
  @MaxLength(90)
  city?: string;

  @ApiPropertyOptional({
    description: 'Operator-defined fields as a flat string map, e.g. {"Order Number":"A-1183"}. Max 30 keys.',
  })
  @IsOptional()
  @IsObject()
  customFields?: Record<string, string>;
}

export class SetConsentDto {
  @ApiProperty({ enum: ConsentStatus })
  @IsEnum(ConsentStatus)
  status!: ConsentStatus;

  @ApiPropertyOptional({
    description:
      'How consent was obtained. REQUIRED when opting a contact in — an opt-in with no provenance is refused.',
    maxLength: 190,
  })
  @IsOptional()
  @IsString()
  @MaxLength(190)
  source?: string;
}
