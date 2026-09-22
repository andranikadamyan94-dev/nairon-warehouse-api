import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AmendProcurementLineDto {
  @IsInt()
  @Type(() => Number)
  orderItemId: number;

  @IsNumber()
  @Min(0)
  @Type(() => Number)
  unitPrice: number;
}

/**
 * Price correction on a received order (2026-09-22): the supplier's invoice
 * differed from the ordered prices. The order keeps ordered and invoiced
 * prices; the difference goes to finance as an adjustment (expense) or a
 * refund (income) through the normal approval.
 */
export class AmendProcurementDto {
  @ApiProperty({ type: [AmendProcurementLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AmendProcurementLineDto)
  lines: AmendProcurementLineDto[];

  @ApiProperty({
    description:
      'Why the prices changed (e.g. VAT was not included in the order).',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({
    description: 'Invoice № the corrected prices come from.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  documentNumber?: string;
}
