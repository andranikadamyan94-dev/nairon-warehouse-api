import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { InventoryService } from './inventory.service';

import { InventoryMovementDto } from './dto/inventory-movement.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

@ApiTags('Inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_inventory')
  @Post('movement')
  @ApiOperation({
    summary: 'Create inventory movement',
  })
  @ApiResponse({
    status: 201,
  })
  createMovement(
    @Body()
    dto: InventoryMovementDto,
  ) {
    return this.inventoryService.createMovement(dto);
  }

  // The movements ledger page has its own permission (2026-09-02); the two
  // inventory super-perms keep access so warehouse staff need no extra grant.
  @UseGuards(PermissionGuard)
  @Permissions(
    'view_inventory_movements',
    'manage_inventory',
    'manage_reservations', // per-task waybill export from the reservations page
    'manage_warehouse',
  )
  @Get('movements')
  @ApiOperation({
    summary: 'Get inventory movements (filterable, paginated)',
  })
  @ApiResponse({
    status: 200,
  })
  getMovements(
    @Query()
    query: {
      itemId?: string;
      taskId?: string;
      type?: string;
      from?: string;
      to?: string;
      page?: string;
      limit?: string;
      warehouseId?: string;
      objectId?: string;
    },
  ) {
    return this.inventoryService.getMovements(query);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_resources', 'manage_inventory', 'manage_items')
  @Get('item/:itemId')
  @ApiOperation({
    summary: 'Get item inventory history',
  })
  @ApiResponse({
    status: 200,
  })
  async getItemMovements(
    @Param('itemId', ParseIntPipe)
    itemId: number,
  ) {
    // Item drawer expects a bare array — unwrap the paged shape.
    const res = await this.inventoryService.getMovements({
      itemId: String(itemId),
      limit: '1000',
    });
    return res.data;
  }
}
