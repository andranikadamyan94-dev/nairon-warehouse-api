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

@ApiTags('Items')
@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post()
  @ApiOperation({
    summary: 'Create item',
  })
  @ApiResponse({
    status: 201,
  })
  create(
    @Body()
    dto: CreateItemDto,
  ) {
    return this.itemsService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Get all items with category filter',
  })
  findAll(
    @Query()
    query: GetItemsQueryDto,
  ) {
    return this.itemsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get item by id',
  })
  findOne(
    @Param('id', ParseIntPipe)
    id: number,
  ) {
    return this.itemsService.findOne(id);
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
  ) {
    return this.itemsService.update(id, dto);
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
  ) {
    return this.itemsService.remove(id);
  }
}
