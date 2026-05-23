import { Body, Controller, Get, Post, Query } from '@nestjs/common';

import { InventoryMovementDto } from './dto/inventory-movement.dto';

import { InventoryService } from './inventory.service';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  @Post('movement')
  createMovement(@Body() dto: InventoryMovementDto) {
    return this.inventoryService.createMovement(dto);
  }

  @Get('movements')
  getMovements(@Query('itemId') itemId?: string) {
    return this.inventoryService.getMovements(
      itemId ? Number(itemId) : undefined,
    );
  }
}
