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

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';

import { ItemsService } from './items.service';
import { GetItemsQueryDto } from './dto/get-items-query.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { Actor } from '../auth/decorators/actor.decorator';
import { WarehouseActor } from '../auth/actor';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { OperationsService } from '../common/operations/operations.service';
import { OperationKey } from '../common/operations/operation-key.decorator';

@ApiTags('Items')
@Controller('items')
export class ItemsController {
  constructor(
    private readonly itemsService: ItemsService,
    private readonly operations: OperationsService,
  ) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post()
  @ApiOperation({
    summary: 'Create item',
  })
  @ApiResponse({
    status: 201,
  })
  async create(
    @Body()
    dto: CreateItemDto,

    @Actor()
    actor: WarehouseActor,

    /*
     * Creating an item twice makes two items, and a caller whose answer went
     * missing has no way to know which happened. A key — opaque, optional, and
     * ignored by every client that predates it — makes the second attempt
     * replay the first instead of doing the work again.
     */
    @OperationKey()
    operationKey?: string,
  ) {
    const { result } = await this.operations.runOnce(
      { key: operationKey, actor, route: 'POST /items', body: dto },
      (tx) => this.itemsService.create(dto, actor, tx),
    );
    return result;
  }

  /**
   * Would this create be accepted? Same guard, same assert, writes nothing.
   * See src/common/preflight/preflight.ts for what this is and is not.
   */
  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post('preflight/create')
  @ApiOperation({ summary: 'Preflight: may this person create this item?' })
  async preflightCreate(@Body() dto: CreateItemDto, @Actor() actor: WarehouseActor) {
    await this.itemsService.assertMayFileUnder(actor, dto.categoryId);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post('preflight/update/:id')
  @ApiOperation({ summary: 'Preflight: may this person change this item?' })
  async preflightUpdate(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateItemDto,
    @Actor() actor: WarehouseActor,
  ) {
    await this.itemsService.findOne(id, actor);
    await this.itemsService.assertMayEdit(actor, id);
    if (dto.categoryId !== undefined) await this.itemsService.assertMayFileUnder(actor, dto.categoryId);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post('preflight/delete/:id')
  @ApiOperation({ summary: 'Preflight: may this person delete this item?' })
  async preflightDelete(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    await this.itemsService.findOne(id, actor);
    await this.itemsService.assertMayEdit(actor, id);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post('preflight/assign-code/:id')
  @ApiOperation({ summary: 'Preflight: may this item get the next system code?' })
  async preflightAssignCode(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    await this.itemsService.assertMayAssignCode(actor, id);
    return PREFLIGHT_OK;
  }

  /**
   * Give an item with no code the system code (RES-000151) — for items made
   * before auto-numbering. Same permission as changing the item. An item that
   * already has a code is refused with 409; its code is never changed.
   */
  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post(':id/assign-code')
  @ApiOperation({ summary: 'Assign the next system code to an item whose code is empty' })
  async assignCode(
    @Param('id', ParseIntPipe) id: number,
    @Actor() actor: WarehouseActor,
    @OperationKey() operationKey?: string,
  ) {
    const { result } = await this.operations.runOnce(
      { key: operationKey, actor, route: 'POST /items/:id/assign-code', body: { id } },
      (tx) => this.itemsService.assignCode(id, actor, tx),
    );
    return result;
  }

  @Get()
  @ApiOperation({
    summary: 'Get all items with category filter',
  })
  findAll(
    @Query()
    query: GetItemsQueryDto,

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.itemsService.findAll(query, actor);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get item by id',
  })
  findOne(
    @Param('id', ParseIntPipe)
    id: number,

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.itemsService.findOne(id, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Patch(':id')
  @ApiOperation({
    summary: 'Update item',
  })
  update(
    @Param('id', ParseIntPipe)
    id: number,

    @Body()
    dto: UpdateItemDto,

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.itemsService.update(id, dto, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Delete(':id')
  @ApiOperation({
    summary: 'Delete item',
  })
  remove(
    @Param('id', ParseIntPipe)
    id: number,

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.itemsService.remove(id, actor);
  }
}
