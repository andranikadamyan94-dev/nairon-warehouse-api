import { ApiPropertyOptional, PartialType } from '@nestjs/swagger';

import { IsInt, IsOptional, ValidateIf } from 'class-validator';

import { CreateCategoryDto } from './create-category.dto';

export class UpdateCategoryDto extends PartialType(CreateCategoryDto) {
  /** null detaches the category to the root level (re-parenting UI). */
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateIf((o) => o.parentId !== null)
  @IsInt()
  parentId?: number | null;
}
