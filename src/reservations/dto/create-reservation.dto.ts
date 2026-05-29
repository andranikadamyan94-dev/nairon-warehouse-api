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

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ResourceReservationItemDto {
  @ApiProperty()
  @IsInt()
  itemId: number;

  @ApiProperty()
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

export class CreateReservationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  taskId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  projectId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  projectName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  entityId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  entityName?: string;

  @ApiProperty()
  @IsDateString()
  startDate: string;

  @ApiProperty()
  @IsDateString()
  endDate: string;

  @ApiProperty({ type: [ResourceReservationItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResourceReservationItemDto)
  resources: ResourceReservationItemDto[];
}
