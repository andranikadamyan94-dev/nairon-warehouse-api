import { IsArray, IsInt, ValidateNested } from 'class-validator';

import { Type } from 'class-transformer';

import { ApiProperty } from '@nestjs/swagger';

export class ReservationAllocationItemDto {
  @ApiProperty()
  @IsInt()
  reservationId: number;

  @ApiProperty()
  @IsInt()
  assetId: number;
}

export class AllocateReservationDto {
  @ApiProperty({
    type: [ReservationAllocationItemDto],
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReservationAllocationItemDto)
  allocations: ReservationAllocationItemDto[];
}
