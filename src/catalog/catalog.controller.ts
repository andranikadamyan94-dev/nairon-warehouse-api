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

import { CatalogService, EMPLOYEE_PERMISSIONS, QUEUE_PERMISSION, QUEUE_VIEWER_PERMISSIONS } from './catalog.service';
import { CheckoutDto } from './dto/checkout.dto';
import {
  ApproveSubmissionDto,
  EditSubmissionDto,
  IssueLineDto,
  RejectSubmissionDto,
  SubmissionTextDto,
} from './dto/submission-actions.dto';

type Q = Record<string, string | undefined>;

/**
 * Warehouse «Կատալոգ» (2026-10-01), §10 of the build spec. Employee side
 * opens with page_warehouse or view_warehouse (2026-10-08, owner: the right that
 * opens the warehouse app is enough to order; view_warehouse kept for project
 * people who already hold it) — the queue with view_catalog_requests (D4), and
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
  @Permissions(...EMPLOYEE_PERMISSIONS)
  @ApiOperation({ summary: 'Catalog items (parents only) with availability' })
  listItems(@Query() query: Q) {
    return this.catalog.listItems(query ?? {});
  }

  @Get('categories')
  @UseGuards(PermissionGuard)
  @Permissions(...EMPLOYEE_PERMISSIONS)
  @ApiOperation({ summary: 'Categories with visible item counts' })
  listCategories() {
    return this.catalog.listCategories();
  }

  @Get('items/:id')
  @UseGuards(PermissionGuard)
  @Permissions(...EMPLOYEE_PERMISSIONS)
  @ApiOperation({ summary: 'One catalog item: variants, attributes, images, documents' })
  getItem(@Param('id', ParseIntPipe) id: number) {
    return this.catalog.getItem(id);
  }

  // ── Checkout ──────────────────────────────────────────────────────────────

  @Post('checkout')
  @UseGuards(PermissionGuard)
  @Permissions(...EMPLOYEE_PERMISSIONS)
  @ApiOperation({ summary: 'Submit the cart: reservations for stocked lines, one requisition for the rest' })
  checkout(@Body() dto: CheckoutDto, @LoggedInUser('id') userId: number, @Actor() actor: WarehouseActor) {
    return this.catalog.checkout(dto, userId, actor);
  }

  @Post('submissions/:id/attachment')
  @UseGuards(PermissionGuard)
  @Permissions(...EMPLOYEE_PERMISSIONS)
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

  // ── Construction objects (2026-10-08) ─────────────────────────────────────

  /** The objects this person may order for — the cart's «Օբյեկտ» picker. */
  @Get('objects')
  @UseGuards(PermissionGuard)
  @Permissions(...EMPLOYEE_PERMISSIONS)
  @ApiOperation({ summary: 'Objects the caller may file a catalog request for (responsible person; the desk sees all)' })
  objects(@Actor() actor: WarehouseActor) {
    return this.catalog.objectsForRequester(actor);
  }

  /**
   * An object's catalog submissions — the CRM object page's «Պահեստային
   * հայտեր» tab. Read rule as GET /reservations/object/:id: view_object_requests,
   * the object's responsible person, or a super admin (the service decides).
   * Declared before `submissions/:id`.
   */
  @Get('submissions/object/:objectId')
  @ApiOperation({ summary: "An object's catalog submissions" })
  forObject(@Param('objectId', ParseIntPipe) objectId: number, @Actor() actor: WarehouseActor) {
    return this.catalog.forObject(objectId, actor);
  }

  // ── Tasks (2026-10-08) ────────────────────────────────────────────────────

  /**
   * The task's card for the catalog chip (/catalog?taskId=): its title, project
   * and object — answered only to someone who may order for it (on the task,
   * or the desk), so the chip never pins a task the checkout would refuse.
   */
  @Get('tasks/:taskId')
  @UseGuards(PermissionGuard)
  @Permissions(...EMPLOYEE_PERMISSIONS)
  @ApiOperation({ summary: 'A task the caller may file a catalog request for (creator, role slot, or the desk)' })
  task(@Param('taskId', ParseIntPipe) taskId: number, @Actor() actor: WarehouseActor) {
    return this.catalog.taskForRequester(taskId, actor);
  }

  /**
   * A task's catalog submissions — the CRM task modal's warehouse block. Read
   * rule as GET /reservations/task/:id: on the task, the warehouse viewers, or
   * the task's own company. Declared before `submissions/:id`.
   */
  @Get('submissions/task/:taskId')
  @ApiOperation({ summary: "A task's catalog submissions" })
  forTask(@Param('taskId', ParseIntPipe) taskId: number, @Actor() actor: WarehouseActor) {
    return this.catalog.forTask(taskId, actor);
  }

  // ── Submissions ───────────────────────────────────────────────────────────

  /** Declared before `submissions/:id` so «mine» is never read as an id. */
  @Get('submissions/mine')
  @UseGuards(PermissionGuard)
  @Permissions(...EMPLOYEE_PERMISSIONS)
  @ApiOperation({ summary: 'My submissions with derived status' })
  mine(@Query() query: Q, @LoggedInUser('id') userId: number) {
    return this.catalog.mine(userId, query ?? {});
  }

  /** The one queue (owner 2026-10-08): the desk and the keepers — see QUEUE_VIEWER_PERMISSIONS. */
  @Get('submissions')
  @UseGuards(PermissionGuard)
  @Permissions(...QUEUE_VIEWER_PERMISSIONS)
  @ApiOperation({ summary: 'The «Ապրանքների հարցումներ» → «Հաստատում» queue: every request, with the keeper filters' })
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

  @Get('submissions/:id/lines/:lineId/units')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations', 'approve_purchase_requisition')
  @ApiOperation({ summary: 'Free units an asset line may take (the Reservations page list) — REQ-1015' })
  units(@Param('id', ParseIntPipe) id: number, @Param('lineId') lineId: string, @Actor() actor: WarehouseActor) {
    return this.catalog.unitsForLine(id, lineId, actor);
  }

  /** «Տրամադրել» from the queue (2026-10-08): the keeper hands out one stock line, part or all. */
  @Patch('submissions/:id/lines/:lineId/issue')
  @UseGuards(PermissionGuard)
  @Permissions('manage_reservations')
  @ApiOperation({ summary: 'Hand out a stock line from the queue: a consumable quantity (partial allowed) or the picked units' })
  issue(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId') lineId: string,
    @Body() dto: IssueLineDto,
    @LoggedInUser('id') userId: number,
    @Actor() actor: WarehouseActor,
  ) {
    return this.catalog.issueLine(id, lineId, dto ?? {}, userId, actor);
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

  @Post('submissions/:id/remind')
  @UseGuards(PermissionGuard)
  @Permissions(QUEUE_PERMISSION)
  @ApiOperation({ summary: '«Հիշեցնել աշխատակցին» — remind the submitter of the unanswered question (once per hour)' })
  remind(@Param('id', ParseIntPipe) id: number, @Actor() actor: WarehouseActor) {
    return this.catalog.remind(id, actor);
  }
}
