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
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PurchaseRequisitionsService } from './purchase-requisitions.service';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';

// Routes without PermissionGuard don't carry req.permissionNames — the
// service resolves access itself for those (same pattern as stock requests).
const ctxOf = (req: any) =>
  req.permissionNames
    ? { isSuperAdmin: !!req.isSuperAdmin, permissionNames: req.permissionNames }
    : undefined;
const entityOf = (req: any): number | null => {
  const v = Number(req.headers?.['x-entity-id'] ?? 0);
  return v > 0 ? v : null;
};

@ApiTags('Purchase requisitions')
@Controller('purchase-requisitions')
export class PurchaseRequisitionsController {
  constructor(private readonly service: PurchaseRequisitionsService) {}

  /** Anyone signed in may file a requisition (#1891) — their own to see/edit. */
  @Post()
  @ApiOperation({ summary: 'File a purchase requisition (draft or submitted)' })
  create(@Body() dto: any, @Req() req: any) {
    return this.service.create(dto, req.user?.id, entityOf(req));
  }

  @Get('mine')
  @ApiOperation({ summary: 'My requisitions' })
  mine(@Query() query: any, @Req() req: any) {
    return this.service.findMine(req.user?.id, query ?? {});
  }

  /** #1894: the requisitions bound to a task (task modal). */
  @Get('by-task/:taskId')
  byTask(@Param('taskId', ParseIntPipe) taskId: number) {
    return this.service.findByTask(taskId);
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_procurement', 'manage_procurement')
  @Get()
  @ApiOperation({ summary: 'Procurement queue (all requisitions except drafts)' })
  findAll(@Query() query: any, @Req() req: any) {
    return this.service.findAll(req.user?.id, query ?? {}, ctxOf(req));
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.findOne(id, req.user?.id, ctxOf(req));
  }

  @Patch(':id')
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @Req() req: any) {
    return this.service.update(id, dto, req.user?.id);
  }

  @Patch(':id/submit')
  submit(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.submit(id, req.user?.id);
  }

  @Patch(':id/cancel')
  cancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.cancel(id, req.user?.id, !!req.isSuperAdmin);
  }

  /** #1893/#1894: bind to a task ({ taskId, origin: CREATED|ATTACHED }) or clear ({ taskId: null }). */
  @Patch(':id/task')
  setTask(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: any) {
    const taskId = body?.taskId != null ? Number(body.taskId) : null;
    const origin = body?.origin === 'CREATED' ? 'CREATED' : 'ATTACHED';
    return this.service.setTask(id, req.user?.id, taskId, origin, ctxOf(req));
  }

  // ── Procurement ───────────────────────────────────────────────────────────

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/review')
  review(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.review(id, req.user?.id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/reject')
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: any) {
    return this.service.reject(id, req.user?.id, body?.reason);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/lines/:lineId/item')
  @ApiOperation({ summary: 'Resolve a free-text line to a catalog item' })
  resolveLine(
    @Param('id', ParseIntPipe) id: number,
    @Param('lineId', ParseIntPipe) lineId: number,
    @Body() body: any,
    @Req() req: any,
  ) {
    return this.service.resolveLine(id, lineId, req.user?.id, Number(body?.itemId));
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/approve')
  @ApiOperation({ summary: 'Approve — raises a DRAFT procurement order from the lines' })
  approve(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.approve(id, req.user?.id);
  }

  // ── Comments + attachments ────────────────────────────────────────────────

  @Post(':id/comments')
  addComment(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: any) {
    return this.service.addComment(id, req.user?.id, body?.text ?? '', ctxOf(req));
  }

  @Post(':id/attachments')
  @UseInterceptors(FileInterceptor('file'))
  @ApiConsumes('multipart/form-data')
  addAttachment(@Param('id', ParseIntPipe) id: number, @UploadedFile() file: Express.Multer.File, @Req() req: any) {
    return this.service.addAttachment(id, req.user?.id, file, ctxOf(req));
  }

  @Delete(':id/attachments/:attachmentId')
  deleteAttachment(
    @Param('id', ParseIntPipe) id: number,
    @Param('attachmentId', ParseIntPipe) attachmentId: number,
    @Req() req: any,
  ) {
    return this.service.deleteAttachment(id, attachmentId, req.user?.id);
  }
}
