import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsObject, IsOptional, IsString, Length, Max, Min, MaxLength } from 'class-validator';
import { ToStrictNumber } from '../../../common/utils/strict-boolean';

/** Where a job came from. Recorded so a surprising send can be traced to whoever asked for it. */
export const JOB_SOURCES = ['software', 'ui', 'agent', 'api', 'module'] as const;

export class CreateWhatsAppDocumentJobDto {
  @ApiProperty({ enum: JOB_SOURCES, example: 'software' })
  @IsIn(JOB_SOURCES)
  source!: string;

  @ApiPropertyOptional({ example: 'USER-001' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  requestedByUserId?: string;

  @ApiProperty({ example: 'invoice' })
  @IsString()
  @Length(1, 64)
  documentType!: string;

  @ApiPropertyOptional({ example: 'INV-1001.pdf' })
  @IsOptional()
  @IsString()
  @MaxLength(190)
  documentName?: string;

  @ApiPropertyOptional({ example: 'INV-1001' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  documentReference?: string;

  @ApiPropertyOptional({ example: 'CLIENT-001' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientId?: string;

  @ApiPropertyOptional({ example: 'PARTY-ALI' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  partyId?: string;

  @ApiPropertyOptional({ example: 'Ali Accounts' })
  @IsOptional()
  @IsString()
  @MaxLength(190)
  recipientName?: string;

  @ApiProperty({ example: '+923001234567', description: 'Country code required' })
  @IsString()
  @Length(8, 24)
  recipientWhatsAppNumber!: string;

  @ApiPropertyOptional({ example: 'Please find your requested invoice attached.' })
  @IsOptional()
  @IsString()
  // WhatsApp caps a media caption at 1024 characters; a longer one is silently truncated by
  // the engine, so it is refused here where the caller can still do something about it.
  @MaxLength(1024)
  messageText?: string;

  @ApiPropertyOptional({ example: { invoiceId: 'INV-1001', companyId: 'COMPANY-001' } })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({ example: 0, description: 'Higher runs first' })
  // Without this the pipe turns a blank field into a real 0, so an empty form control would
  // quietly assert a priority nobody chose.
  @ToStrictNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  priority?: number;

  @ApiProperty({ example: 'invoice-INV-1001-923001234567' })
  @IsString()
  @Length(6, 190)
  idempotencyKey!: string;
}
