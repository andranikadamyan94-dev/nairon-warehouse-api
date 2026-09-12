import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MaintenanceService } from './maintenance.service';
import { CreateMaintenanceRecordDto } from './dto/create-maintenance-record.dto';
import { PaginationQueryDto } from 'src/common/dto/pagination-query.dto';
import { Public } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { FinalizeMaintenanceDto } from './dto/finalize-maintenance.dto';
import { UpdateMaintenanceRecordDto } from './dto/update-maintenance-record.dto';
import { Actor } from '../auth/decorators/actor.decorator';
import { WarehouseActor } from '../auth/actor';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { OperationsService } from '../common/operations/operations.service';
import { OperationKey } from '../common/operations/operation-key.decorator';

@ApiTags('Maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(
    private readonly maintenanceService: MaintenanceService,
    private readonly operations: OperationsService,
  ) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Post()
  @ApiOperation({ summary: 'Create maintenance record' })
  async createRecord(
    @Body() dto: CreateMaintenanceRecordDto,
    @Actor() actor: WarehouseActor,
    /* See POST /items: an optional key makes a lost answer safe to retry. */
    @OperationKey() operationKey?: string,
  ) {
    const { result } = await this.operations.runOnce(
      { key: operationKey, actor, route: 'POST /maintenance', body: dto },
      (tx) => this.maintenanceService.createRecord(dto, actor, tx),
    );
    return result;
  }

  /** Writes nothing; see src/common/preflight/preflight.ts. */
  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Post('preflight/create')
  @ApiOperation({ summary: 'Preflight: may this person raise maintenance on this asset?' })
  async preflightCreate(
    @Body() dto: CreateMaintenanceRecordDto,
    @Actor() actor: WarehouseActor,
  ) {
    await this.maintenanceService.assertMayMaintain(actor, dto.assetId);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Post('preflight/update/:id')
  @ApiOperation({ summary: 'Preflight: may this person change this record?' })
  async preflightUpdate(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    await this.maintenanceService.assertMayEdit(actor, id);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_maintenance', 'manage_maintenance')
  @Get('upcoming')
  @ApiOperation({ summary: 'Get upcoming maintenance' })
  getUpcomingMaintenance(@Actor() actor: WarehouseActor) {
    return this.maintenanceService.getUpcomingMaintenance(actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_maintenance', 'manage_maintenance', 'view_assets', 'manage_assets')
  @Get('asset/:assetId')
  @ApiOperation({ summary: 'Get asset maintenance history' })
  getAssetMaintenanceHistory(
    @Param('assetId', ParseIntPipe) assetId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.maintenanceService.getAssetMaintenanceHistory(assetId, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_maintenance', 'manage_maintenance')
  @Get()
  getAll(@Query() query: PaginationQueryDto, @Actor() actor: WarehouseActor) {
    return this.maintenanceService.getAll(query, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_maintenance', 'manage_maintenance')
  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    return this.maintenanceService.getOne(id, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMaintenanceRecordDto,
    @Actor() actor: WarehouseActor,
  ) {
    return this.maintenanceService.update(id, dto, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Post(':id/finalize')
  @ApiOperation({ summary: 'Submit maintenance for finance approval' })
  finalize(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: FinalizeMaintenanceDto,
    @Actor() actor: WarehouseActor,
  ) {
    return this.maintenanceService.finalize(id, body.amount, body.prepaymentAmount, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Post(':id/complete')
  @ApiOperation({ summary: 'Mark maintenance as completed — asset back in service' })
  complete(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    return this.maintenanceService.complete(id, actor);
  }

  @Public()
  @UseGuards(InternalGuard)
  @Get(':id/internal')
  @ApiOperation({ summary: 'Get maintenance record details (internal)' })
  getOneInternal(@Param('id', ParseIntPipe) id: number) {
    return this.maintenanceService.getOne(id);
  }

  @Public()
  @UseGuards(InternalGuard)
  @Post(':id/finance-callback')
  @ApiOperation({ summary: 'Finance approval callback (called by finance API)' })
  financeCallback(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: 'APPROVED' | 'REJECTED'; rejectionReason?: string },
  ) {
    return this.maintenanceService.financeCallback(id, body.status, body.rejectionReason);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    return this.maintenanceService.remove(id, actor);
  }
}
