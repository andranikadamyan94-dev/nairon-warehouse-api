import { IsEnum, IsInt, IsOptional, IsString } from 'class-validator';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AssetStatus } from '../../common/enums/asset-status.enum';

export class CreateAssetDto {
  @ApiProperty()
  @IsInt()
  itemId: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serialNumber?: string;

  @ApiPropertyOptional({
    enum: AssetStatus,
  })
  @IsOptional()
  @IsEnum(AssetStatus)
  status?: AssetStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  responsibleUserId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;
}
