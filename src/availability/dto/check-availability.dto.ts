import {
  IsArray,
  IsDateString,
  IsInt,
  IsNumber,
  ValidateNested,
} from 'class-validator';

import { Type } from 'class-transformer';

export class ResourceAvailabilityItemDto {
  @IsInt()
  itemId: number;

  @IsNumber()
  quantity: number;
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
}
