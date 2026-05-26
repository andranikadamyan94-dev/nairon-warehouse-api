import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ReservationsService } from './reservations.service';

import { CreateReservationDto } from './dto/create-reservation.dto';
import { AllocateReservationDto } from './dto/allocate-reservation.dto';
import { ReallocateResourceDto } from './dto/reallocate-resource.dto';
import { ReleaseAllocationDto } from './dto/release-allocation.dto';
import { PaginationQueryDto } from 'src/common/dto/pagination-query.dto';

@ApiTags('Reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  @ApiOperation({
    summary: 'Create resource reservations',
  })
  @ApiResponse({
    status: 201,
  })
  create(
    @Body()
    dto: CreateReservationDto,
  ) {
    return this.reservationsService.create(dto);
  }

  @Patch('task/:taskId')
  updateTaskReservations(
    @Param('taskId')
    taskId: string,

    @Body()
    dto: CreateReservationDto,
  ) {
    return this.reservationsService.updateTaskReservations(+taskId, dto);
  }

  @Get('task/:taskId')
  getTaskReservations(
    @Param('taskId')
    taskId: string,
  ) {
    return this.reservationsService.getTaskReservations(+taskId);
  }

  @Post('allocate')
  @ApiOperation({
    summary: 'Allocate physical assets to reservations',
  })
  @ApiResponse({
    status: 201,
  })
  allocate(
    @Body()
    dto: AllocateReservationDto,
  ) {
    return this.reservationsService.allocate(dto);
  }

  @Post('reallocate')
  @ApiOperation({
    summary: 'Replace allocated asset',
  })
  @ApiResponse({
    status: 200,
  })
  reallocate(
    @Body()
    dto: ReallocateResourceDto,
  ) {
    return this.reservationsService.reallocate(dto);
  }

  @Delete('allocation')
  @ApiOperation({
    summary: 'Release allocation',
  })
  @ApiResponse({
    status: 200,
  })
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

  @Get()
  getAll(
    @Query()
    query: PaginationQueryDto,
  ) {
    return this.reservationsService.getAll(query);
  }

  @Get(':id')
  getOne(
    @Param('id')
    id: string,
  ) {
    return this.reservationsService.getOne(+id);
  }
}
