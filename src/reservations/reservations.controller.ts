import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { WarehouseStaffGuard } from '../auth/guards/warehouse-staff.guard';
import { LoggedInUser } from '../auth/decorators/logged-in-user.decorator';

import { ReservationsService } from './reservations.service';

import { CreateReservationDto } from './dto/create-reservation.dto';
import { AllocateReservationDto } from './dto/allocate-reservation.dto';
import { ReallocateResourceDto } from './dto/reallocate-resource.dto';
import { ReleaseAllocationDto } from './dto/release-allocation.dto';
import { PaginationQueryDto } from 'src/common/dto/pagination-query.dto';
import { IsOptional, IsString } from 'class-validator';

class ReasonDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('Reservations')
@Controller('reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Post()
  @ApiOperation({ summary: 'Create resource reservations' })
  @ApiResponse({ status: 201 })
  create(@Body() dto: CreateReservationDto) {
    return this.reservationsService.create(dto);
  }

  @Patch('task/:taskId')
  updateTaskReservations(
    @Param('taskId') taskId: string,
    @Body() dto: CreateReservationDto,
  ) {
    return this.reservationsService.updateTaskReservations(+taskId, dto);
  }

  @Get('task/:taskId')
  getTaskReservations(@Param('taskId') taskId: string) {
    return this.reservationsService.getTaskReservations(+taskId);
  }

  @Post('allocate')
  @UseGuards(WarehouseStaffGuard)
  @ApiOperation({ summary: 'Allocate physical assets to reservations' })
  @ApiResponse({ status: 201 })
  allocate(@Body() dto: AllocateReservationDto, @LoggedInUser('id') userId: number) {
    return this.reservationsService.allocate(dto, userId);
  }

  @Post('reallocate')
  @UseGuards(WarehouseStaffGuard)
  @ApiOperation({ summary: 'Replace allocated asset' })
  @ApiResponse({ status: 200 })
  reallocate(@Body() dto: ReallocateResourceDto) {
    return this.reservationsService.reallocate(dto);
  }

  @Delete('allocation')
  @UseGuards(WarehouseStaffGuard)
  @ApiOperation({ summary: 'Release allocation' })
  @ApiResponse({ status: 200 })
  releaseAllocation(@Body() dto: ReleaseAllocationDto) {
    return this.reservationsService.releaseAllocation(dto.allocationId, undefined, dto.reason);
  }

  // Warehouse staff approves a consumable reservation (no specific asset to assign)
  @Patch(':id/approve')
  @UseGuards(WarehouseStaffGuard)
  @ApiOperation({ summary: 'Approve consumable reservation' })
  approveConsumable(@Param('id') id: string, @LoggedInUser('id') userId: number) {
    return this.reservationsService.approveConsumable(+id, userId);
  }

  // Cancel any active reservation, releasing any allocations
  @Patch(':id/cancel')
  @UseGuards(WarehouseStaffGuard)
  @ApiOperation({ summary: 'Cancel a reservation' })
  cancel(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.reservationsService.cancel(+id, undefined, dto.reason);
  }

  @Patch(':id/uncancel')
  @UseGuards(WarehouseStaffGuard)
  @ApiOperation({ summary: 'Reactivate a cancelled reservation' })
  uncancel(@Param('id') id: string) {
    return this.reservationsService.uncancel(+id);
  }

  // Reject a PENDING reservation
  @Patch(':id/reject')
  @UseGuards(WarehouseStaffGuard)
  @ApiOperation({ summary: 'Reject a pending reservation' })
  reject(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.reservationsService.reject(+id, undefined, dto.reason);
  }

  @Get()
  getAll(@Query() query: PaginationQueryDto) {
    return this.reservationsService.getAll(query);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.reservationsService.getOne(+id);
  }

}
