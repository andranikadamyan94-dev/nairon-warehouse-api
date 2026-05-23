import { IsArray, IsInt, ValidateNested } from 'class-validator';

import { Type } from 'class-transformer';

export class ReservationAllocationItemDto {
  @IsInt()
  reservationId: number;

  @IsInt()
  assetId: number;
}

export class AllocateReservationDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationAllocationItemDto)
  allocations: ReservationAllocationItemDto[];
}
