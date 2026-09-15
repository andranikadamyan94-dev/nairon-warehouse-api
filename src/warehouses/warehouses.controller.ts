import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { WarehousesService } from './warehouses.service';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

@ApiTags('Warehouses')
@Controller('warehouses')
export class WarehousesController {
  constructor(private readonly warehousesService: WarehousesService) {}

  // Read access is broader than management: transfer/reservation staff need
  // the warehouse list for pickers and labels.
  @UseGuards(PermissionGuard)
  @Permissions('manage_warehouses', 'manage_stock_transfers', 'manage_reservations', 'manage_inventory', 'manage_warehouse')
  @Get()
  @ApiOperation({ summary: 'List warehouses' })
  findAll(@Query() query: any) {
    return this.warehousesService.findAll(query);
  }

  // The switcher's list — membership-scoped, so any signed-in warehouse user
  // may ask; they only get warehouses they can enter. Declared before ':id'.
  @Get('mine')
  @ApiOperation({ summary: 'Warehouses the caller can enter' })
  findMine(@Req() req: any) {
    // No PermissionGuard here — the service resolves access info itself.
    return this.warehousesService.findMine(req.user?.id);
  }

  // Declared before ':id' — Nest matches in order.
  @UseGuards(PermissionGuard)
  @Permissions('manage_warehouses')
  @Get('backlogs')
  @ApiOperation({ summary: 'CRM backlogs for the linked-project picker' })
  listBacklogs() {
    return this.warehousesService.listBacklogs();
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_warehouses', 'manage_stock_transfers', 'manage_reservations', 'manage_inventory', 'manage_warehouse')
  @Get(':id/stock')
  @ApiOperation({ summary: 'Project warehouse stock' })
  getStock(@Param('id', ParseIntPipe) id: number) {
    return this.warehousesService.getStock(id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_warehouses')
  @Post()
  @ApiOperation({ summary: 'Create a project warehouse' })
  create(@Body() dto: any, @Req() req: any) {
    return this.warehousesService.create(dto, req.user?.id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_warehouses')
  @Patch(':id')
  @ApiOperation({ summary: 'Update a project warehouse' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any) {
    return this.warehousesService.update(id, dto);
  }
}
