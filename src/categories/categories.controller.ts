import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiTags } from '@nestjs/swagger';

import { CategoriesService } from './categories.service';

import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

@ApiTags('Categories')
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @UseGuards(PermissionGuard)
  @Permissions('manage_categories')
  @Post()
  create(
    @Body()
    dto: CreateCategoryDto,
  ) {
    return this.categoriesService.create(dto);
  }

  @Get()
  getAll(@Query('entityId') entityId?: string) {
    return this.categoriesService.getAll(entityId ? Number(entityId) : undefined);
  }

  @Get('tree')
  getTree(@Query('entityId') entityId?: string) {
    return this.categoriesService.getTree(entityId ? Number(entityId) : undefined);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_categories')
  @Patch(':id')
  update(
    @Param('id')
    id: string,

    @Body()
    dto: UpdateCategoryDto,
  ) {
    return this.categoriesService.update(+id, dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_categories')
  @Delete(':id')
  remove(
    @Param('id')
    id: string,
  ) {
    return this.categoriesService.remove(+id);
  }
}
