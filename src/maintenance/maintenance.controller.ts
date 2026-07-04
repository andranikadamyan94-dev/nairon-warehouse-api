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

@ApiTags('Maintenance')
@Controller('maintenance')
export class MaintenanceController {
  constructor(private readonly maintenanceService: MaintenanceService) {}

  @Post()
  @ApiOperation({ summary: 'Create maintenance record' })
  createRecord(@Body() dto: CreateMaintenanceRecordDto) {
    return this.maintenanceService.createRecord(dto);
  }

  @Get('upcoming')
  @ApiOperation({ summary: 'Get upcoming maintenance' })
  getUpcomingMaintenance() {
    return this.maintenanceService.getUpcomingMaintenance();
  }

  @Get('asset/:assetId')
  @ApiOperation({ summary: 'Get asset maintenance history' })
  getAssetMaintenanceHistory(@Param('assetId', ParseIntPipe) assetId: number) {
    return this.maintenanceService.getAssetMaintenanceHistory(assetId);
  }

  @Get()
  getAll(@Query() query: PaginationQueryDto) {
    return this.maintenanceService.getAll(query);
  }

  @Get(':id')
  getOne(@Param('id', ParseIntPipe) id: number) {
    return this.maintenanceService.getOne(id);
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    return this.maintenanceService.update(id, dto);
  }

  @Post(':id/finalize')
  @ApiOperation({ summary: 'Submit maintenance for finance approval' })
  finalize(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { amount: number },
  ) {
    return this.maintenanceService.finalize(id, body.amount);
  }

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

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.maintenanceService.remove(id);
  }
}
