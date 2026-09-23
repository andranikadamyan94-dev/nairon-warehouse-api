import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Create is a POST: name and code are the warehouse's required identity, so
 * they must be present and non-empty. `@Transform` trims first so a
 * whitespace-only value is rejected as empty (matches the service's own
 * `.trim()`). The remaining fields are optional. `status` is accepted but
 * ignored — the create form always sends it (default ACTIVE) and the global
 * pipe's forbidNonWhitelisted would otherwise 400 the whole request; the
 * service creates every new warehouse ACTIVE regardless.
 */
export class CreateWarehouseDto {
  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  code: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  responsibleId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  location?: string;

  // Accepted-and-ignored: the form always posts it, the service forces ACTIVE.
  @ApiPropertyOptional({ enum: ['ACTIVE', 'INACTIVE'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  backlogIds?: number[];

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  employeeIds?: number[];
}
