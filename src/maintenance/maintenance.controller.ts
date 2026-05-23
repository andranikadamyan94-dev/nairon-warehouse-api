import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { MaintenanceService } from './maintenance.service';

import { CreateMaintenanceRecordDto } from './dto/create-maintenance-record.dto';

@ApiTags('Maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post()
  @ApiOperation({
    summary: 'Create maintenance record',
  })
  @ApiResponse({
    status: 201,
  })
  createRecord(
    @Body()
    dto: CreateMaintenanceRecordDto,
  ) {
    return this.maintenanceService.createRecord(dto);
  }

  @Get('upcoming')
  @ApiOperation({
    summary: 'Get upcoming maintenance',
  })
  @ApiResponse({
    status: 200,
  })
  getUpcomingMaintenance() {
    return this.maintenanceService.getUpcomingMaintenance();
  }

  @Get('asset/:assetId')
  @ApiOperation({
    summary: 'Get asset maintenance history',
  })
  @ApiResponse({
    status: 200,
  })
  getAssetMaintenanceHistory(
    @Param('assetId', ParseIntPipe)
    assetId: number,
  ) {
    return this.maintenanceService.getAssetMaintenanceHistory(assetId);
  }
}
