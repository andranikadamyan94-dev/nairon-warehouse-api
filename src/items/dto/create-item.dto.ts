import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

import { Type, Transform } from 'class-transformer';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { ItemType } from '../../common/enums/item-type.enum';
import { ItemUnit } from '../../common/enums/item-unit.enum';
import { ItemStockingMode } from '../../common/enums/item-stocking-mode.enum';
import { ItemAttributeDto } from './item-attribute.dto';

export class CreateItemDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional({ description: 'A second name shown on hover and searched like the first; null clears it' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  secondaryName?: string | null;

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

  /** #2042: current unit cost (AMD), frozen onto movements at write time.
   *  Manually maintained until the cost-update policy is decided. */
  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) => (value === null || value === '' ? null : Number(value)))
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  @Min(0)
  unitCost?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  // ── Catalog (2026-10-01) ──────────────────────────────────────────────────

  @ApiPropertyOptional({ description: '«Բրենդ»; null clears it' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  brand?: string | null;

  @ApiPropertyOptional({ description: '«Մոդել»; null clears it' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  model?: string | null;

  @ApiPropertyOptional({ description: 'Long «Նկարագրություն» for the item page; notes stays internal' })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ enum: ItemStockingMode, description: 'STOCKED (default) or ON_REQUEST («Միայն հարցմամբ»)' })
  @IsOptional()
  @IsEnum(ItemStockingMode)
  stockingMode?: ItemStockingMode;

  @ApiPropertyOptional({ description: 'false hides the item from the employee catalog without deleting it' })
  @IsOptional()
  @IsBoolean()
  catalogVisible?: boolean;

  /** «Բնութագրեր» — replace-all; order = array order. */
  @ApiPropertyOptional({ type: [ItemAttributeDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ItemAttributeDto)
  attributes?: ItemAttributeDto[];
}
