import { IsDefined, IsEnum, IsInt, IsOptional, IsString } from 'class-validator';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import { AssetStatus } from '../../common/enums/asset-status.enum';

export class CreateAssetDto {
  @ApiProperty()
  @IsDefined()
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

  /**
   * Accepted for old clients and IGNORED (2026-10-08): the responsible person is
   * the live custody holder, written by asset custody only (see AssetsService).
   */
  @ApiPropertyOptional({ deprecated: true, description: 'Ignored — custody is the only writer' })
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
