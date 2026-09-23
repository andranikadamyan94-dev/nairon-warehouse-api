import { IsArray, IsInt, IsOptional, IsPositive, ValidateNested } from 'class-validator';

import { Type } from 'class-transformer';

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ReservationAllocationItemDto {
  @ApiProperty()
  @IsInt()
  reservationId: number;

  @ApiProperty()
  @IsInt()
  assetId: number;

  @ApiPropertyOptional({ description: 'The person responsible for the asset while the task holds it; defaults to the task executor' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  holderUserId?: number;
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
