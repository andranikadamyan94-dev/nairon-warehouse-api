import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { IsInt, IsOptional, IsString } from 'class-validator';

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
}
