import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsPositive, IsString } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateReturnDto {
  @ApiProperty()
  @IsInt()
  @Type(() => Number)
  reservationId: number;

  @ApiProperty()
  // Fractional since 2026-09-15 (0.3 kg comes back too).
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  quantity: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  requestedBy?: number;
}
