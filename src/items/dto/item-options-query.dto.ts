import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ItemType } from 'src/common/enums/item-type.enum';

/** GET /items/options — a picker's remote search (performance audit 2026-10-13). */
export class ItemOptionsQueryDto {
  /** Matched against the name, the second name and the code, case-insensitive. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @ApiPropertyOptional({ enum: ItemType })
  @IsOptional()
  @IsEnum(ItemType)
  type?: ItemType;

  /** '1' = variant (child) items as well, as on GET /items. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  includeVariants?: string;
}
