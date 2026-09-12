import { IsDateString, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateMaintenanceRecordDto {
  @ApiProperty()
  @IsInt()
  assetId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  maintainerId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  amount?: number;

  @ApiProperty()
  @IsDateString()
  startDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  type?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  /**
   * Accepted for the clients that still send it, and ignored: the author
   * recorded is whoever holds the token. Removing the field would answer 400 to
   * a request that works today, so it stays and does nothing.
   */
  @ApiPropertyOptional({ deprecated: true, description: 'Ignored; the caller is the author.' })
  @IsOptional()
  @IsInt()
  createdBy?: number;
}
