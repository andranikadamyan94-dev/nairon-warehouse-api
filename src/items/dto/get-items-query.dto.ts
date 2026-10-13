import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ItemType } from 'src/common/enums/item-type.enum';

export class GetItemsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  categoryId?: number;

  @ApiPropertyOptional({ enum: ItemType })
  @IsOptional()
  @IsEnum(ItemType)
  type?: ItemType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  /** '1' = only items with no category (the Առանց կատեգորիայի tab). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  uncategorized?: string;

  /** 'main' or a sub-warehouse id — scopes quantities/asset counts (#1989). */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  warehouseId?: string;

  /** '1' = list variant (child) items as well; by default only parents and standalone items. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  includeVariants?: string;

  /** '1' = one page as { items, total }, variants grouped under their parent (the Ռեսուրսներ list). Without it: the full array, as always. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  paged?: string;

  /** With paged=1: rows to skip (default 0). */
  @ApiPropertyOptional({ default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;

  /** With paged=1: rows per page (default 10, at most 100). */
  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  take?: number;
}
