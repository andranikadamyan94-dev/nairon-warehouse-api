import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

import { ApiProperty } from '@nestjs/swagger';

export class ResourceReservationItemDto {
  @ApiProperty()
  @IsInt()
  itemId: number;

  @ApiProperty()
  @IsNumber()
  quantity: number;
}

export class CreateReservationDto {
  @ApiProperty()
  @IsInt()
  taskId: number;

  @ApiProperty()
  @IsDateString()
  startDate: string;

  @ApiProperty()
  @IsDateString()
  endDate: string;

  @ApiProperty({
    type: [ResourceReservationItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResourceReservationItemDto)
  resources: ResourceReservationItemDto[];
}
