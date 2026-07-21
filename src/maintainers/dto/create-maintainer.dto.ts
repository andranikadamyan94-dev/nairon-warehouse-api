import { IsArray, IsEmail, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export class MaintainerManagerDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;
}

export class CreateMaintainerDto {
  @IsString()
  @MaxLength(255)
  name: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  actingAddress?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaintainerManagerDto)
  managers?: MaintainerManagerDto[];

  @IsOptional()
  @IsString()
  bankName?: string;

  @IsOptional()
  @IsString()
  bankAccount?: string;

  @IsOptional()
  @IsString()
  registryNumber?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
