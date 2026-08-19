import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from 'class-validator';

import { Type, Transform } from 'class-transformer';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ItemType } from '../../common/enums/item-type.enum';
import { ItemUnit } from '../../common/enums/item-unit.enum';

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

  @ApiPropertyOptional({ enum: ItemUnit })
  @IsOptional()
  @IsEnum(ItemUnit)
  unit?: ItemUnit;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  quantity?: number;

  @ApiPropertyOptional({
    description:
      'Low-stock threshold. Alerts fire when quantity <= minQuantity. Null clears it (no alerting); omitting it leaves the current value untouched. CONSUMABLE only.',
  })
  @IsOptional()
  // Explicit null must survive as null — it is how the UI turns alerting off.
  // Type(() => Number) would coerce it to 0, which instead means "alert at zero".
  @Transform(({ value }) => (value === null || value === '' ? null : Number(value)))
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  minQuantity?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  maintenanceRequired?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}
