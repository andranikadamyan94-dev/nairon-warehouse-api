import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { ObjectsService } from './objects.service';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { Public } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';

const VIEW_PERMS = [
  'view_resources',
  'manage_inventory',
  'manage_reservations',
  'manage_warehouses',
  'manage_stock_transfers',
  'manage_warehouse',
] as const;

@ApiTags('Construction objects (warehouse side)')
@Controller('objects')
export class ObjectsController {
  constructor(private readonly objectsService: ObjectsService) {}

  // CRM asks before deleting an object. Before ':objectId' routes.
  @Public()
  @UseGuards(InternalGuard)
  @Get('internal/usage/:objectId')
  usage(@Param('objectId', ParseIntPipe) objectId: number) {
    return this.objectsService.usage(objectId);
  }

  @UseGuards(PermissionGuard)
  @Permissions(...VIEW_PERMS)
  @Get()
  @ApiOperation({ summary: 'Object labels (CRM proxy) for pickers/filters' })
  list() {
    return this.objectsService.list();
  }

  @UseGuards(PermissionGuard)
  @Permissions(...VIEW_PERMS)
  @Get(':objectId/materials')
  @ApiOperation({ summary: 'Per-item actuals at frozen costs' })
  materials(@Param('objectId', ParseIntPipe) objectId: number) {
    return this.objectsService.materials(objectId);
  }

  @UseGuards(PermissionGuard)
  @Permissions(...VIEW_PERMS)
  @Get(':objectId/movements')
  @ApiOperation({ summary: 'Raw ledger rows of the object (paginated)' })
  movements(@Param('objectId', ParseIntPipe) objectId: number, @Query() query: any) {
    return this.objectsService.movements(objectId, query);
  }

  @UseGuards(PermissionGuard)
  @Permissions(...VIEW_PERMS)
  @Get(':objectId/summary')
  @ApiOperation({ summary: 'Planned vs actual comparison' })
  summary(@Param('objectId', ParseIntPipe) objectId: number) {
    return this.objectsService.summary(objectId);
  }

  @UseGuards(PermissionGuard)
  @Permissions(...VIEW_PERMS)
  @Get(':objectId/estimate')
  @ApiOperation({ summary: 'Estimate lines' })
  listEstimate(@Param('objectId', ParseIntPipe) objectId: number) {
    return this.objectsService.listEstimate(objectId);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_warehouses')
  @Post(':objectId/estimate')
  @ApiOperation({ summary: 'Add/replace an estimate line' })
  upsertEstimate(@Param('objectId', ParseIntPipe) objectId: number, @Body() dto: any) {
    return this.objectsService.upsertEstimateLine(objectId, dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_warehouses')
  @Delete(':objectId/estimate/:lineId')
  @ApiOperation({ summary: 'Remove an estimate line' })
  removeEstimate(
    @Param('objectId', ParseIntPipe) objectId: number,
    @Param('lineId', ParseIntPipe) lineId: number,
  ) {
    return this.objectsService.removeEstimateLine(objectId, lineId);
  }
}
