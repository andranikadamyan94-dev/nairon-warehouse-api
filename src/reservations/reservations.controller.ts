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
import { Public } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
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
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse', 'manage_reservations')
  @ApiOperation({ summary: 'Create resource reservations' })
  @ApiResponse({ status: 201 })
  create(@Body() dto: CreateReservationDto, @LoggedInUser('id') userId?: number) {
    return this.reservationsService.create(dto, userId);
  }

  @Patch('task/:taskId')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse', 'manage_reservations')
  updateTaskReservations(
    @Param('taskId') taskId: string,
    @Body() dto: CreateReservationDto,
    // Task-side edits were the only flow writing history with no author.
    @LoggedInUser('id') userId?: number,
  ) {
    return this.reservationsService.updateTaskReservations(+taskId, dto, userId);
  }

  @Get('task/:taskId')
  getTaskReservations(@Param('taskId') taskId: string) {
    return this.reservationsService.getTaskReservations(+taskId);
  }

  // 2026-09-05 policy: a task's object may change only until the warehouse
  // has issued ANYTHING for it. CRM calls this on every object change — it
  // re-stamps pending requests atomically, or reports the task frozen.
  @Public()
  @UseGuards(InternalGuard)
  @Patch('internal/task/:taskId/object')
  @ApiOperation({ summary: 'Re-stamp a task\'s pending reservations to a new object, or report it frozen (internal)' })
  restampTaskObject(
    @Param('taskId') taskId: string,
    @Body() body: { objectId?: number | null },
  ) {
    return this.reservationsService.restampTaskObject(+taskId, body?.objectId ?? null);
  }

  @Post('allocate')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Allocate physical assets to reservations' })
  @ApiResponse({ status: 201 })
  allocate(@Body() dto: AllocateReservationDto, @LoggedInUser('id') userId: number) {
    return this.reservationsService.allocate(dto, userId);
  }

  @Post('reallocate')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Replace allocated asset' })
  @ApiResponse({ status: 200 })
  reallocate(@Body() dto: ReallocateResourceDto) {
    return this.reservationsService.reallocate(dto);
  }

  @Delete('allocation')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Release allocation' })
  @ApiResponse({ status: 200 })
  releaseAllocation(@Body() dto: ReleaseAllocationDto) {
    return this.reservationsService.releaseAllocation(dto.allocationId, undefined, dto.reason);
  }

  // Warehouse staff approves a consumable reservation (no specific asset to
  // assign). An optional quantity issues just part of the request (#1880) —
  // the remainder stays open as PARTIALLY_ALLOCATED.
  @Patch(':id/approve')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Approve consumable reservation (optionally a partial quantity)' })
  approveConsumable(
    @Param('id') id: string,
    @LoggedInUser('id') userId: number,
    @Body() body?: { quantity?: number },
  ) {
    return this.reservationsService.approveConsumable(+id, userId, body?.quantity);
  }

  // The task side confirms physical receipt of issued goods (#1882/#1883).
  // Warehouse staff take back the issued-but-unaccepted remainder (#dispute
  // resolution): damaged goods are scrapped, usable ones return to stock —
  // either way the issuance ceiling reopens for replacements.
  @Patch(':id/reclaim')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Take back issued-but-unaccepted goods (damaged = no stock credit)' })
  reclaim(
    @Param('id') id: string,
    @LoggedInUser('id') userId: number,
    @Body() body: { quantity: number; damaged?: boolean; reason?: string },
  ) {
    return this.reservationsService.reclaim(+id, userId, Number(body?.quantity), !!body?.damaged, body?.reason);
  }

  // Any authenticated task participant may call; the service validates the
  // caller against the task's role slots in CRM.
  @Patch(':id/accept')
  @ApiOperation({ summary: 'Task-side acceptance of issued goods (partial allowed with a comment)' })
  accept(
    @Param('id') id: string,
    @LoggedInUser('id') userId: number,
    @Body() body: { quantity: number; comment?: string },
  ) {
    return this.reservationsService.accept(+id, userId, Number(body?.quantity), body?.comment);
  }

  // Cancel any active reservation, releasing any allocations
  @Patch(':id/cancel')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Cancel a reservation' })
  cancel(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.reservationsService.cancel(+id, undefined, dto.reason);
  }

  @Patch(':id/uncancel')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Reactivate a cancelled reservation' })
  uncancel(@Param('id') id: string) {
    return this.reservationsService.uncancel(+id);
  }

  // Reject a PENDING reservation
  @Patch(':id/reject')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Reject a pending reservation' })
  reject(@Param('id') id: string, @Body() dto: ReasonDto) {
    return this.reservationsService.reject(+id, undefined, dto.reason);
  }

  @Get('mine')
  @ApiOperation({ summary: 'Reservations belonging to tasks assigned to the logged-in user' })
  getMine(@LoggedInUser('id') userId: number, @Query() query: PaginationQueryDto) {
    return this.reservationsService.getMine(userId, query);
  }

  @Get()
  @UseGuards(PermissionGuard)
  @Permissions('view_reservations', 'manage_reservations')
  getAll(@Query() query: PaginationQueryDto) {
    return this.reservationsService.getAll(query);
  }

  @Get(':id')
  @UseGuards(PermissionGuard)
  @Permissions('view_reservations', 'manage_reservations')
  getOne(@Param('id') id: string) {
    return this.reservationsService.getOne(+id);
  }

}
