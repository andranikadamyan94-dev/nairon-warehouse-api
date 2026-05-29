import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class ResourceAvailabilityItemDto {
  @IsInt()
  itemId: number;

  @IsNumber()
  quantity: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  startTime?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  endTime?: string;
}

export class CheckAvailabilityDto {
  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResourceAvailabilityItemDto)
  resources: ResourceAvailabilityItemDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  excludeTaskId?: number;
}
