import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsOptional, IsString, IsArray, IsNumber, ValidateNested } from 'class-validator';
import { Transform, Type } from 'class-transformer';

/**
 * #2514 (2026-10-09): supplier validation lives on the server, for create AND
 * update (the update DTO inherits these rules through PartialType).
 *
 *   name   trimmed first, then required and non-empty — "", " " are refused,
 *          " թեստ " is stored as "թեստ". No character restriction beyond that
 *          (owner: «թեստ😊» stays allowed).
 *   email  optional; trimmed; an empty string counts as absent; when present
 *          it must be a valid address ("test", "abcdef" → 400).
 *
 * The messages are the global pipe's Armenian ones (validation-messages.ts):
 * «Անվանում» դաշտը պարտադիր է / «Էլ. հասցե» դաշտը պետք է լինի վավեր էլ. հասցե.
 */
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** Trimmed; an empty string becomes undefined so @IsOptional lets it through. */
const trimOrAbsent = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() || undefined : value;

export class SupplierManagerDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
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
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional()
  @Transform(trimOrAbsent)
  @IsOptional()
  @IsEmail()
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
