import { ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional, IsString } from 'class-validator';

export class CreateCategoryDto {
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
}
