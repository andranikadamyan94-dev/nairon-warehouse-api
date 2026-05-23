import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';

import { MaintenanceService } from './maintenance.service';

import { CreateMaintenanceRecordDto } from './dto/create-maintenance-record.dto';

@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post()
  createRecord(
    @Body()
    dto: CreateMaintenanceRecordDto,
  ) {
    return this.maintenanceService.createRecord(dto);
  }

  @Get('upcoming')
  getUpcomingMaintenance() {
    return this.maintenanceService.getUpcomingMaintenance();
  }

  @Get('asset/:assetId')
  getAssetMaintenanceHistory(
    @Param('assetId', ParseIntPipe)
    assetId: number,
  ) {
    return this.maintenanceService.getAssetMaintenanceHistory(assetId);
  }
}
