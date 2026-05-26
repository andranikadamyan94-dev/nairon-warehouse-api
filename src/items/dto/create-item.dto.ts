import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

import { Type } from 'class-transformer';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ItemType } from '../../common/enums/item-type.enum';

export class CreateItemDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({ enum: ItemType })
  @IsEnum(ItemType)
  type: ItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  categoryId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  unit?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  quantity?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  maintenanceRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
