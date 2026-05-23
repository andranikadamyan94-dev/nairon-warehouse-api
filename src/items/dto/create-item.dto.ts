import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

import { ItemType } from '../../common/enums/item-type.enum';

export class CreateItemDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsEnum(ItemType)
  type: ItemType;

  @IsOptional()
  @IsString()
  category?: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsOptional()
  @IsNumber()
  quantity?: number;

  @IsOptional()
  @IsBoolean()
  maintenanceRequired?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}
