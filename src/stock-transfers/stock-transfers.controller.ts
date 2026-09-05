import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { StockTransfersService } from './stock-transfers.service';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

@ApiTags('Stock transfers')
@Controller('stock-transfers')
export class StockTransfersController {
  constructor(private readonly stockTransfersService: StockTransfersService) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_stock_transfers', 'manage_warehouses', 'manage_warehouse')
  @Get()
  @ApiOperation({ summary: 'Transfer history' })
  findAll(@Query() query: any) {
    return this.stockTransfersService.findAll(query);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_stock_transfers')
  @Post()
  @ApiOperation({ summary: 'Transfer stock from main to a project warehouse' })
  create(@Body() dto: any, @Req() req: any) {
    return this.stockTransfersService.create(dto, req.user?.id);
  }
}
