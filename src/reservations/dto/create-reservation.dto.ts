import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

export class ResourceReservationItemDto {
  @IsInt()
  itemId: number;

  @IsNumber()
  quantity: number;
}

export class CreateReservationDto {
  @IsInt()
  taskId: number;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ResourceReservationItemDto)
  resources: ResourceReservationItemDto[];
}
