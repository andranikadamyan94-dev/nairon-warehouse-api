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
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';

import { ApiConsumes, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { UpdateImageDto } from './dto/update-image.dto';

import { ItemsService } from './items.service';
import { GetItemsQueryDto } from './dto/get-items-query.dto';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { Actor } from '../auth/decorators/actor.decorator';
import { WarehouseActor } from '../auth/actor';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { OperationsService } from '../common/operations/operations.service';
import { OperationKey } from '../common/operations/operation-key.decorator';

/** Gallery uploads: at most this many files in one request (and per item). */
const MAX_IMAGE_FILES = 10;
/** Documents: a handful of manuals at a time. */
const MAX_DOCUMENT_FILES = 10;

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

  // ── Catalog phase A (2026-10-01): variants, images, documents ─────────────
  // Writes sit behind the item form's own rule, manage_items (which
  // manage_warehouse, the warehouse super-permission, also opens).

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post(':id/variants')
  @ApiOperation({ summary: 'Add a variant — a child item inheriting name, type, unit and category' })
  createVariant(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateVariantDto,
    @Actor() actor: WarehouseActor,
  ) {
    return this.itemsService.createVariant(id, dto, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Patch(':id/variants/:variantId')
  @ApiOperation({ summary: 'Rename a variant / change its code' })
  updateVariant(
    @Param('id', ParseIntPipe) id: number,
    @Param('variantId', ParseIntPipe) variantId: number,
    @Body() dto: UpdateVariantDto,
    @Actor() actor: WarehouseActor,
  ) {
    return this.itemsService.updateVariant(id, variantId, dto, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Delete(':id/variants/:variantId')
  @ApiOperation({ summary: 'Delete a variant (refused while it has stock, assets, reservations or movements)' })
  removeVariant(
    @Param('id', ParseIntPipe) id: number,
    @Param('variantId', ParseIntPipe) variantId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.itemsService.removeVariant(id, variantId, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post(':id/images')
  @UseInterceptors(FilesInterceptor('files', MAX_IMAGE_FILES))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload gallery images (files[]: jpg/png/webp, ≤ 5 MB each, ≤ 10 per item)' })
  addImages(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
    @Actor() actor: WarehouseActor,
  ) {
    return this.itemsService.addImages(id, files, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Patch(':id/images/:imageId')
  @ApiOperation({ summary: 'Make an image the cover and/or reorder it' })
  updateImage(
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Body() dto: UpdateImageDto,
    @Actor() actor: WarehouseActor,
  ) {
    return this.itemsService.updateImage(id, imageId, dto, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Delete(':id/images/:imageId')
  @ApiOperation({ summary: 'Delete an image' })
  removeImage(
    @Param('id', ParseIntPipe) id: number,
    @Param('imageId', ParseIntPipe) imageId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.itemsService.removeImage(id, imageId, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Post(':id/documents')
  @UseInterceptors(FilesInterceptor('files', MAX_DOCUMENT_FILES))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Upload documents (files[]: pdf/doc/docx/xls/xlsx, ≤ 10 MB)' })
  addDocuments(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFiles() files: Express.Multer.File[],
    @Actor() actor: WarehouseActor,
  ) {
    return this.itemsService.addDocuments(id, files, actor);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_items')
  @Delete(':id/documents/:docId')
  @ApiOperation({ summary: 'Delete a document' })
  removeDocument(
    @Param('id', ParseIntPipe) id: number,
    @Param('docId', ParseIntPipe) docId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.itemsService.removeDocument(id, docId, actor);
  }
}
