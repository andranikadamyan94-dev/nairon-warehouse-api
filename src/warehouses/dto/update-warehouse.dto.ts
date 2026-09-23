import { Transform } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';

import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Edit is a PATCH: the form sends every field it shows, so an omitted key means
 * "don't touch" and a present key means "set to this". name and code are the
 * warehouse's required identity — when they ARE sent they must be a real,
 * non-empty string. `@ValidateIf(!== undefined)` (not `@IsOptional`) is
 * deliberate: `@IsOptional` also skips `null`, which would let a null name pass
 * validation and reach the service; here null and '' are both rejected, while a
 * fully omitted field is still allowed.
 */
export class UpdateWarehouseDto {
  @ApiPropertyOptional()
  @ValidateIf((o) => o.name !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional()
  @ValidateIf((o) => o.code !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  code?: string;

  // null clears the responsible; a number sets it; omitted leaves it as is.
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsInt()
  responsibleId?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  location?: string | null;

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
