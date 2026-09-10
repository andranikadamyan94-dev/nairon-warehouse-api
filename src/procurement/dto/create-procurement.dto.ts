import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

export class ProcurementItemDto {
  @ApiProperty()
  @IsInt()
  itemId: number;

  @ApiProperty()
  @IsNumber()
  quantity: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  unitPrice?: number;
}

export class CreateProcurementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  supplierId?: number;

  /** Which organization the purchase is for. Defaults to the buyer's active
   *  one when the client does not name it; travels to finance at finalize. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  entityId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  /** Deposit the supplier requires up front. Raised as its own transfer. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @Min(0)
  prepaymentAmount?: number;

  @ApiProperty({ type: [ProcurementItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProcurementItemDto)
  items: ProcurementItemDto[];
}
