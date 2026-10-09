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
 * `.trim()`). The remaining fields are optional. `status` is honoured (#2338,
 * 2026-10-09): a warehouse created as «Ոչ ակտիվ» is stored INACTIVE; absent,
 * the service defaults to ACTIVE. (It used to be accepted and ignored.)
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

  /** The chosen status; ACTIVE when absent (#2338). */
  @ApiPropertyOptional({ enum: ['ACTIVE', 'INACTIVE'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'INACTIVE'])
  status?: 'ACTIVE' | 'INACTIVE';

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  /** CRM project ids this warehouse serves (2026-09-29; was backlogIds). */
  projectIds?: number[];

  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  employeeIds?: number[];
}
