import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsArray, IsNumber, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class SupplierManagerDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class SupplierItemDto {
  @IsNumber()
  itemId: number;

  @IsNumber()
  unitPrice: number;
}

export class CreateSupplierDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  actingAddress?: string;

  @ApiPropertyOptional({ type: [SupplierManagerDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SupplierManagerDto)
  managers?: SupplierManagerDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankAccount?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  registryNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ type: [SupplierItemDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SupplierItemDto)
  items?: SupplierItemDto[];
}
