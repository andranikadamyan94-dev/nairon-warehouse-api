import {
  Body,
  Controller,
  Delete,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { ReservationsService } from './reservations.service';

import { CreateReservationDto } from './dto/create-reservation.dto';
import { AllocateReservationDto } from './dto/allocate-reservation.dto';
import { ReallocateResourceDto } from './dto/reallocate-resource.dto';
import { ReleaseAllocationDto } from './dto/release-allocation.dto';

@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  create(
    @Body()
    dto: CreateReservationDto,
  ) {
    return this.reservationsService.create(dto);
  }

  @Post('allocate')
  allocate(
    @Body()
    dto: AllocateReservationDto,
  ) {
    return this.reservationsService.allocate(dto);
  }

  @Delete('allocation')
  releaseAllocation(
    @Body()
    dto: ReleaseAllocationDto,
  ) {
    return this.reservationsService.releaseAllocation(
      dto.allocationId,
      undefined,
      dto.reason,
    );
  }

  @Post('reallocate')
  reallocate(
    @Body()
    dto: ReallocateResourceDto,
  ) {
    return this.reservationsService.reallocate(dto);
  }
}
