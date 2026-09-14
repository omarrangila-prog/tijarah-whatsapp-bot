import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { ToStrictBoolean, ToStrictNumber } from '../../../common/utils/strict-boolean';
import { RoutingStrategy } from '../entities/workspace-settings.entity';

export class HeartbeatDto {
  @ApiPropertyOptional({
    description: 'Conversation the agent currently has open, so teammates can see it is being handled.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  viewingConversationId?: string | null;

  @ApiPropertyOptional({ description: 'Whether the agent is typing into that conversation right now.' })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  typing?: boolean;
}

export class UpdateRoutingDto {
  @ApiPropertyOptional({
    enum: RoutingStrategy,
    description:
      'manual = agents claim from the queue; round_robin = each new conversation to the next agent in turn; ' +
      'least_busy = to whoever holds the fewest open conversations.',
  })
  @IsOptional()
  @IsEnum(RoutingStrategy)
  routingStrategy?: RoutingStrategy;

  @ApiPropertyOptional({ description: 'Route only to this team. Omit or null to use every active agent.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  routingTeamId?: string | null;

  @ApiPropertyOptional({
    description:
      'Skip agents who are not currently online. On by default — assigning work to someone who has gone ' +
      'home looks handled while nobody is handling it.',
  })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  routeToOnlineOnly?: boolean;

  @ApiPropertyOptional({
    description: 'Refuse to auto-assign an agent already holding this many open conversations. 0 = no ceiling.',
    minimum: 0,
    maximum: 500,
  })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(0)
  @Max(500)
  maxOpenPerAgent?: number;

  @ApiPropertyOptional({
    description:
      'When on, an agent sees only their own conversations plus the unassigned queue; conversations ' +
      'another agent owns are hidden from them. Admins always see everything.',
  })
  @IsOptional()
  @ToStrictBoolean()
  @IsBoolean()
  privateAssignedChats?: boolean;

  @ApiPropertyOptional({ description: 'Minutes of silence before an agent counts as away.', minimum: 1, maximum: 120 })
  @IsOptional()
  @ToStrictNumber()
  @IsInt()
  @Min(1)
  @Max(120)
  presenceTimeoutMinutes?: number;
}
