import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
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

  @UseGuards(PermissionGuard)
  @Permissions('view_resources', 'manage_inventory', 'manage_items')
  @Get('movements')
  @ApiOperation({
    summary: 'Get inventory movements',
  })
  @ApiResponse({
    status: 200,
  })
  getMovements() {
    return this.inventoryService.getMovements();
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
  getItemMovements(
    @Param('itemId', ParseIntPipe)
    itemId: number,
  ) {
    return this.inventoryService.getMovements(itemId);
  }
}
