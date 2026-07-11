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

@ApiTags('Maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Post()
  @ApiOperation({ summary: 'Create maintenance record' })
  createRecord(@Body() dto: CreateMaintenanceRecordDto) {
    return this.maintenanceService.createRecord(dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_maintenance', 'manage_maintenance')
  @Get('upcoming')
  @ApiOperation({ summary: 'Get upcoming maintenance' })
  getUpcomingMaintenance() {
    return this.maintenanceService.getUpcomingMaintenance();
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_maintenance', 'manage_maintenance', 'view_assets', 'manage_assets')
  @Get('asset/:assetId')
  @ApiOperation({ summary: 'Get asset maintenance history' })
  getAssetMaintenanceHistory(@Param('assetId', ParseIntPipe) assetId: number) {
    return this.maintenanceService.getAssetMaintenanceHistory(assetId);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_maintenance', 'manage_maintenance')
  @Get()
  getAll(@Query() query: PaginationQueryDto) {
    return this.maintenanceService.getAll(query);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_maintenance', 'manage_maintenance')
  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.maintenanceService.getOne(id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    return this.maintenanceService.update(id, dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Post(':id/finalize')
  @ApiOperation({ summary: 'Submit maintenance for finance approval' })
  finalize(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { amount: number },
  ) {
    return this.maintenanceService.finalize(id, body.amount);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Post(':id/complete')
  @ApiOperation({ summary: 'Mark maintenance as completed — asset back in service' })
  complete(@Param('id', ParseIntPipe) id: number) {
    return this.maintenanceService.complete(id);
  }

  @Public()
  @UseGuards(InternalGuard)
  @Post(':id/finance-callback')
  @ApiOperation({ summary: 'Finance approval callback (called by finance API)' })
  financeCallback(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: 'APPROVED' | 'REJECTED' },
  ) {
    return this.maintenanceService.financeCallback(id, body.status);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_maintenance')
  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.maintenanceService.remove(id);
  }
}
