import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';

import { Transform } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';

import { CreateCategoryDto } from './create-category.dto';

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  // UpdateWarehouseDto.
  @ApiPropertyOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @ValidateIf((o) => o.name !== undefined)
  @IsString()
  @IsNotEmpty()
  name?: string;

  /** null detaches the category to the root level (re-parenting UI). */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((o) => o.parentId !== null)
  @IsInt()
  parentId?: number | null;
}
