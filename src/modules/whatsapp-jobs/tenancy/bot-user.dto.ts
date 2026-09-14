import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';

/**
 * Registers one WhatsApp number as a Tijarah user.
 *
 * `sid` and `grp` are the company the host resolves that number to; every report and every
 * draft the person asks for is scoped to them. Getting the pair wrong shows someone another
 * company's books, which is why this is ADMIN-only and why the number is normalised before it
 * is stored — a trunk-zero and an international form of the same phone must be the same row.
 */
export class UpsertBotUserDto {
  @ApiProperty({ example: '03001234567', description: 'The WhatsApp number, any local or international form' })
  @IsString()
  @MaxLength(20)
  whatsAppNo!: string;

  @ApiProperty({ example: 1006, description: 'Tijarah company id (Sid)' })
  @IsInt()
  @Min(1)
  sid!: number;

  @ApiProperty({ example: 'GR', description: 'Tijarah group (Grp)' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,16}$/)
  grp!: string;

  @ApiProperty({ example: '2026', description: 'Accounting year the reports default to' })
  @IsString()
  @Matches(/^\d{4}(-\d{2,4})?$/)
  aYear!: string;

  @ApiPropertyOptional({ example: 'Ahmed Traders — owner' })
  @IsOptional()
  @IsString()
  @MaxLength(190)
  displayName?: string;
}
