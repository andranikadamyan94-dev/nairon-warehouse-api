import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsArray, IsInt, IsOptional, IsString } from 'class-validator';

export class CreateCategoryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  entityId?: number;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  parentId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  position?: number;

  /** Existing categories to re-parent under the new node (create-time only). */
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  childIds?: number[];
}
