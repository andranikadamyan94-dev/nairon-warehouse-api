import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { Actor } from '../auth/decorators/actor.decorator';
import { LoggedInUser } from '../auth/decorators/logged-in-user.decorator';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { WarehouseActor } from '../auth/actor';

import { CatalogService, QUEUE_PERMISSION } from './catalog.service';
import { CheckoutDto } from './dto/checkout.dto';
import {
  ApproveSubmissionDto,
  EditSubmissionDto,
  RejectSubmissionDto,
  SubmissionTextDto,
} from './dto/submission-actions.dto';

type Q = Record<string, string | undefined>;

/**
 * Warehouse «Կատալոգ» (2026-10-01), §10 of the build spec. Employee side
 * opens with view_warehouse — the right project people already hold to ask
 * the warehouse for things — the queue with view_catalog_requests (D4), and
 * the decisions with the two existing approval permissions, split per line
 * kind inside the service (D3).
 */
@ApiTags('Catalog')
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  // ── Catalog ───────────────────────────────────────────────────────────────

  @Get('items')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse')
  @ApiOperation({ summary: 'Catalog items (parents only) with availability' })
  listItems(@Query() query: Q) {
    return this.catalog.listItems(query ?? {});
  }

  @Get('categories')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse')
  @ApiOperation({ summary: 'Categories with visible item counts' })
  listCategories() {
    return this.catalog.listCategories();
  }

  @Get('items/:id')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse')
  @ApiOperation({ summary: 'One catalog item: variants, attributes, images, documents' })
  getItem(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.getItem(id);
  }

  // ── Checkout ──────────────────────────────────────────────────────────────

  @Post('checkout')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse')
  @ApiOperation({ summary: 'Submit the cart: reservations for stocked lines, one requisition for the rest' })
  checkout(@Body() dto: CheckoutDto, @LoggedInUser('id') userId: number, @Actor() actor: WarehouseActor) {
    return this.catalog.checkout(dto, userId, actor);
  }

  @Post('submissions/:id/attachment')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({ summary: 'Attach a file to a submission (requester)' })
  attach(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
    @LoggedInUser('id') userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.catalog.addAttachment(id, userId, file, actor);
  }

  // ── Submissions ───────────────────────────────────────────────────────────

  /** Declared before `submissions/:id` so «mine» is never read as an id. */
  @Get('submissions/mine')
  @UseGuards(PermissionGuard)
  @Permissions('view_warehouse')
  @ApiOperation({ summary: 'My submissions with derived status' })
  mine(@Query() query: Q, @LoggedInUser('id') userId: number) {
    return this.catalog.mine(userId, query ?? {});
  }

  @Get('submissions')
  @UseGuards(PermissionGuard)
  @Permissions(QUEUE_PERMISSION)
  @ApiOperation({ summary: 'The «Կատալոգի հարցումներ» queue' })
  queue(@Query() query: Q, @Actor() actor: WarehouseActor) {
    return this.catalog.queue(query ?? {}, actor);
  }

  @Get('submissions/:id')
  @ApiOperation({ summary: 'One submission (owner or queue viewer)' })
  getOne(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    return this.catalog.getOne(id, actor);
  }

  @Patch('submissions/:id')
  @ApiOperation({ summary: 'Edit quantities / purpose / date while nothing is approved (D7)' })
  edit(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: EditSubmissionDto,
    @LoggedInUser('id') userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.catalog.edit(id, dto, userId, actor);
  }

  @Patch('submissions/:id/cancel')
  @ApiOperation({ summary: 'Cancel every underlying row while nothing is approved (D7)' })
  cancel(@Param('id', ParseIntPipe) id: number, @LoggedInUser('id') userId: number, @Actor() actor: WarehouseActor) {
    return this.catalog.cancel(id, userId, actor);
  }

  @Post('submissions/:id/reply')
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Answer an information request (JSON or multipart with `file`)' })
  reply(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmissionTextDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @LoggedInUser('id') userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.catalog.reply(id, dto.text, file, userId, actor);
  }

  // ── Queue decisions ───────────────────────────────────────────────────────

  @Patch('submissions/:id/approve')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations', 'approve_purchase_requisition')
  @ApiOperation({ summary: 'Approve lines, fully or partially; 0 rejects a line' })
  approve(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveSubmissionDto,
    @LoggedInUser('id') userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.catalog.approve(id, dto, userId, actor);
  }

  @Patch('submissions/:id/reject')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations', 'approve_purchase_requisition')
  @ApiOperation({ summary: 'Reject the lines the caller may decide on' })
  reject(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectSubmissionDto,
    @LoggedInUser('id') userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.catalog.reject(id, dto.reason, userId, actor);
  }

  @Patch('submissions/:id/return')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations', 'approve_purchase_requisition')
  @ApiOperation({ summary: '«Պահանջել տեղեկություն» — return for information' })
  requestInfo(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SubmissionTextDto,
    @LoggedInUser('id') userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.catalog.requestInfo(id, dto.text, userId, actor);
  }
}
