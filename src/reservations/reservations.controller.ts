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
import { Actor } from '../auth/decorators/actor.decorator';
import { OperationsService } from '../common/operations/operations.service';
import { OperationKey } from '../common/operations/operation-key.decorator';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { WarehouseActor } from '../auth/actor';

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
  constructor(
    private readonly reservationsService: ReservationsService,
    private readonly operations: OperationsService,
  ) {}

  /**
   * Who may ASK for goods (owner's decision, 2026-09-20).
   *
   * `view_warehouse` opens no page of the warehouse app — it is the CRM
   * task panel's right, held by project people so they can request what a
   * task needs. Asking is not approving: a request lands PENDING or APPROVED
   * by the stock rules, and `manage_reservations` is what approves,
   * allocates, rejects and cancels. So the two are paired here again, and
   * the requester rule in the service still binds who may ask for whose
   * work. `manage_warehouse` passes as the warehouse super-permission.
   */
  @Post()
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse', 'manage_reservations')
  @ApiOperation({ summary: 'Create resource reservations' })
  @ApiResponse({ status: 201 })
  async create(
    @Body() dto: CreateReservationDto,
    @Actor() actor: WarehouseActor,
    @LoggedInUser('id') userId?: number,
    /* One request can make many rows; asking twice makes them twice. */
    @OperationKey() operationKey?: string,
  ) {
    const { result } = await this.operations.runOnce(
      { key: operationKey, actor, route: 'POST /reservations', body: dto },
      () => this.reservationsService.create(dto, userId, actor),
    );
    return result;
  }

  /**
   * Would this reservation request be accepted, and what would it do?
   *
   * Same guards, same authority, same measurements, nothing written. Unlike the
   * other preflights in the estate this answers more than `{ok:true}`: one
   * request becomes several rows, and a person cannot agree to "a reservation"
   * without being told which resources, from whose shelves, and how many rows
   * an hourly item turns into. See src/common/preflight/preflight.ts for what a
   * preflight is and is not — it is still UX validation, never permission, and
   * the availability in it is explicitly informational.
   */
  @Post('preflight/create')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse', 'manage_reservations')
  @ApiOperation({ summary: 'Preflight: may this be reserved, and what would it create?' })
  async preflightCreate(@Body() dto: CreateReservationDto, @Actor() actor: WarehouseActor) {
    return { ...PREFLIGHT_OK, request: await this.reservationsService.previewCreate(dto, actor) };
  }

  @Post('preflight/task/:taskId')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse', 'manage_reservations')
  @ApiOperation({ summary: 'Preflight: what would changing this task’s resources do?' })
  async preflightUpdate(
    @Param('taskId') taskId: string,
    @Body() dto: CreateReservationDto,
    @Actor() actor: WarehouseActor,
  ) {
    return { ...PREFLIGHT_OK, request: await this.reservationsService.previewUpdate(+taskId, dto, actor) };
  }

  @Patch('task/:taskId')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse', 'manage_reservations')
  updateTaskReservations(
    @Param('taskId') taskId: string,
    @Body() dto: CreateReservationDto,
    @Actor() actor: WarehouseActor,
    // Task-side edits were the only flow writing history with no author.
    @LoggedInUser('id') userId?: number,
  ) {
    return this.reservationsService.updateTaskReservations(+taskId, dto, userId, actor);
  }

  @Get('task/:taskId')
  getTaskReservations(@Param('taskId') taskId: string, @Actor() actor: WarehouseActor) {
    return this.reservationsService.getTaskReservations(+taskId, actor);
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

  // 2026-09-16: a task may not be marked Կատարված while goods it asked the
  // warehouse for are still unaccepted. CRM asks here before the verdict.
  @Public()
  @UseGuards(InternalGuard)
  @Get('internal/task/:taskId/unaccepted')
  @ApiOperation({ summary: "A task's reservations still awaiting issue or acceptance (internal)" })
  unacceptedForTask(@Param('taskId') taskId: string) {
    return this.reservationsService.unacceptedForTask(+taskId);
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
    @Actor() actor: WarehouseActor,
    @Body() body?: { quantity?: number },
  ) {
    return this.reservationsService.approveConsumable(+id, userId, body?.quantity, actor);
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

  /**
   * "Could this be cancelled, right now?" — behind the same guard as the
   * mutation, calling the same assert, writing nothing and releasing nothing.
   *
   * It answers with the whole snapshot a confirmation card needs, because what
   * cancelling actually does is release a specific set of allocations, and a
   * caller that worked that out separately would be reading the world twice.
   */
  @Post(':id/preflight/cancel')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Could this reservation be cancelled right now — writes nothing' })
  async preflightCancel(@Param('id') id: string, @Actor() actor: WarehouseActor) {
    const snapshot = await this.reservationsService.cancelSnapshot(+id, actor);
    return { ok: true as const, ...snapshot };
  }

  // Cancel any active reservation, releasing any allocations
  @Patch(':id/cancel')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Cancel a reservation' })
  cancel(@Param('id') id: string, @Body() dto: ReasonDto, @Actor() actor: WarehouseActor) {
    return this.reservationsService.cancel(+id, actor?.userId, dto.reason, actor);
  }

  @Patch(':id/uncancel')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Reactivate a cancelled reservation' })
  uncancel(@Param('id') id: string, @Actor() actor: WarehouseActor) {
    return this.reservationsService.uncancel(+id, actor?.userId, actor);
  }

  // Reject a PENDING reservation
  @Patch(':id/reject')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Reject a pending reservation' })
  reject(@Param('id') id: string, @Body() dto: ReasonDto, @Actor() actor: WarehouseActor) {
    return this.reservationsService.reject(+id, actor?.userId, dto.reason, actor);
  }

  @Get('mine')
  @ApiOperation({ summary: 'Reservations belonging to tasks assigned to the logged-in user' })
  getMine(@LoggedInUser('id') userId: number, @Query() query: PaginationQueryDto) {
    return this.reservationsService.getMine(userId, query);
  }

  @Get()
  @UseGuards(PermissionGuard)
  // receive_reservation_alerts: alert holders can open the list the alert links to.
  @Permissions('view_reservations', 'manage_reservations', 'receive_reservation_alerts')
  getAll(@Query() query: PaginationQueryDto) {
    return this.reservationsService.getAll(query);
  }

  @Get(':id')
  @UseGuards(PermissionGuard)
  @Permissions('view_reservations', 'manage_reservations', 'receive_reservation_alerts')
  getOne(@Param('id') id: string, @Actor() actor: WarehouseActor) {
    return this.reservationsService.getOne(+id, actor);
  }

}
