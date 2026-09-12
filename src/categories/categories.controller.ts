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
import { Actor } from '../auth/decorators/actor.decorator';
import { WarehouseActor } from '../auth/actor';
import { PREFLIGHT_OK } from '../common/preflight/preflight';

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

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.categoriesService.create(dto, actor);
  }

  /** Writes nothing; see src/common/preflight/preflight.ts. */
  @UseGuards(PermissionGuard)
  @Permissions('manage_categories')
  @Post('preflight/create')
  async preflightCreate(@Body() dto: CreateCategoryDto, @Actor() actor: WarehouseActor) {
    await this.categoriesService.assertMayCreate(actor, dto);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_categories')
  @Post('preflight/update/:id')
  async preflightUpdate(
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
    @Actor() actor: WarehouseActor,
  ) {
    await this.categoriesService.assertMayEdit(actor, +id);
    await this.categoriesService.assertMayCreate(actor, dto);
    return PREFLIGHT_OK;
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_categories')
  @Post('preflight/delete/:id')
  async preflightDelete(@Param('id') id: string, @Actor() actor: WarehouseActor) {
    await this.categoriesService.assertMayEdit(actor, +id);
    return PREFLIGHT_OK;
  }

  @Get()
  getAll(@Actor() actor: WarehouseActor, @Query('entityId') entityId?: string) {
    return this.categoriesService.getAll(entityId ? Number(entityId) : undefined, actor);
  }

  @Get('tree')
  getTree(@Actor() actor: WarehouseActor, @Query('entityId') entityId?: string) {
    return this.categoriesService.getTree(entityId ? Number(entityId) : undefined, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_categories')
  @Patch(':id')
  update(
    @Param('id')
    id: string,

    @Body()
    dto: UpdateCategoryDto,

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.categoriesService.update(+id, dto, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_categories')
  @Delete(':id')
  remove(
    @Param('id')
    id: string,

    @Actor()
    actor: WarehouseActor,
  ) {
    return this.categoriesService.remove(+id, actor);
  }
}
