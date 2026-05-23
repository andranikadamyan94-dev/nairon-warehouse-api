import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
} from '@nestjs/common';

import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';

import { ItemsService } from './items.service';

@ApiTags('Items')
@Controller('items')
export class ItemsController {
  constructor(private readonly itemsService: ItemsService) {}

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
    summary: 'Get all items',
  })
  findAll() {
    return this.itemsService.findAll();
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
