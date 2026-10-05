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
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { OperationsService } from '../common/operations/operations.service';
import { OperationKey } from '../common/operations/operation-key.decorator';

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
  constructor(
    private readonly service: PurchaseRequisitionsService,
    private readonly operations: OperationsService,
  ) {}

  /**
   * Filing needs create_purchase_requisition in the active organization (the
   * service checks).
   *
   * Filing twice files two requisitions, and a caller whose answer went missing
   * cannot tell which happened. With an `Idempotency-Key` the second attempt
   * replays the first instead — see OperationsService. The organization is
   * part of the intent even though it arrives as a header rather than in the
   * body, so it is fingerprinted with the body: the same key sent for another
   * organization is a conflict, never a replay of a requisition filed
   * somewhere else. `req.actor` is the one AuthGuard resolved.
   */
  @Post()
  @ApiOperation({ summary: 'File a purchase requisition (draft or submitted)' })
  async create(@Body() dto: any, @Req() req: any, @OperationKey() operationKey?: string) {
    const entityId = entityOf(req);
    const { result } = await this.operations.runOnce(
      { key: operationKey, actor: req.actor, route: 'POST /purchase-requisitions', body: { entityId, dto } },
      (tx) => this.service.create(dto, req.user?.id, entityId, tx),
    );
    return result;
  }

  /**
   * Would this requisition be accepted? Same route, same service checks as
   * create — create_purchase_requisition in the active organization, the
   * lines, the period — and nothing written. Answers the lines as the
   * catalogue resolves them. See src/common/preflight/preflight.ts.
   */
  @Post('preflight/create')
  @ApiOperation({ summary: 'Preflight: may this person file this requisition, and what would it be?' })
  async preflightCreate(@Body() dto: any, @Req() req: any) {
    return { ...PREFLIGHT_OK, request: await this.service.previewCreate(dto, req.user?.id, entityOf(req)) };
  }

  @Get('mine')
  @ApiOperation({ summary: 'My requisitions' })
  mine(@Query() query: any, @Req() req: any) {
    return this.service.findMine(req.user?.id, query ?? {});
  }

  /** #1894: the requisitions bound to a task (task modal). */
  @Get('by-task/:taskId')
  byTask(@Param('taskId', ParseIntPipe) taskId: number, @Req() req: any) {
    // Who may see which of them is the service's question (2026-10-01).
    const authorization = typeof req.headers?.authorization === 'string' ? req.headers.authorization : undefined;
    return this.service.findByTask(taskId, req.user?.id, ctxOf(req), { authorization, entityId: entityOf(req) });
  }

  /**
   * The approval desk. The guard admits anyone holding the permission
   * somewhere, and the desk is global (owner, 2026-10-05): every
   * organisation's rows, whatever X-Entity-ID says.
   */
  @UseGuards(PermissionGuard)
  @Permissions('approve_purchase_requisition')
  @Get('approvals')
  @ApiOperation({ summary: 'Requisitions of every organisation awaiting (or past) approval' })
  approvals(@Query() query: any, @Req() req: any) {
    return this.service.findForApproval(req.user?.id, query ?? {});
  }

  @UseGuards(PermissionGuard)
  @Permissions('confirm_requisition_rejection')
  @Get('rejections')
  @ApiOperation({ summary: 'Rejections of every organisation awaiting confirmation (or already decided)' })
  rejections(@Query() query: any, @Req() req: any) {
    return this.service.findRejections(req.user?.id, query ?? {});
  }

  @UseGuards(PermissionGuard)
  @Permissions('view_procurement', 'manage_procurement')
  @Get()
  @ApiOperation({ summary: 'Procurement queue (all requisitions except drafts)' })
  findAll(@Query() query: any, @Req() req: any) {
    return this.service.findAll(req.user?.id, query ?? {}, ctxOf(req));
  }

  /*
   * The assistant's preflights for the requester's own acts (2026-10-01) — see
   * src/common/preflight/preflight.ts and the service's previewSubmit /
   * previewUpdate / previewCancel / previewComment. Each sits beside its
   * mutation on the same unguarded route shape (the service is the gate for
   * both), takes the mutation's own body, writes nothing, and answers what a
   * confirmation card needs. Declared before ':id' so no GET shadows them.
   */
  @Post(':id/preflight/submit')
  @ApiOperation({ summary: 'Preflight: may this person send their draft for approval?' })
  async preflightSubmit(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return { ...PREFLIGHT_OK, ...(await this.service.previewSubmit(id, req.user?.id)) };
  }

  @Post(':id/preflight/update')
  @ApiOperation({ summary: 'Preflight: may this person change their requisition, and to what?' })
  async preflightUpdate(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @Req() req: any) {
    return { ...PREFLIGHT_OK, ...(await this.service.previewUpdate(id, dto ?? {}, req.user?.id)) };
  }

  @Post(':id/preflight/cancel')
  @ApiOperation({ summary: 'Preflight: may this person withdraw their requisition?' })
  async preflightCancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return { ...PREFLIGHT_OK, ...(await this.service.previewCancel(id, req.user?.id)) };
  }

  @Post(':id/preflight/comment')
  @ApiOperation({ summary: 'Preflight: may this person comment on their requisition?' })
  async preflightComment(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: any) {
    return { ...PREFLIGHT_OK, ...(await this.service.previewComment(id, req.user?.id, body?.text ?? '')) };
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

  // ── Organization approval ─────────────────────────────────────────────────

  @UseGuards(PermissionGuard)
  @Permissions('approve_purchase_requisition')
  @Patch(':id/org-approve')
  @ApiOperation({ summary: 'Organization approval — lets the requisition through to procurement' })
  orgApprove(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.orgApprove(id, req.user?.id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('approve_purchase_requisition')
  @Patch(':id/org-reject')
  @ApiOperation({ summary: 'Organization rejection, with a reason for the requester' })
  orgReject(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: any) {
    return this.service.orgReject(id, req.user?.id, body?.reason);
  }

  // ── Rejection confirmation (2026-09-25) ──────────────────────────────────

  @UseGuards(PermissionGuard)
  @Permissions('confirm_requisition_rejection')
  @Patch(':id/confirm-rejection')
  @ApiOperation({ summary: 'The rejection stands — the requisition becomes REJECTED' })
  confirmRejection(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.service.confirmRejection(id, req.user?.id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('confirm_requisition_rejection')
  @Patch(':id/decline-rejection')
  @ApiOperation({ summary: 'The rejection is declined — the requisition returns to where it was' })
  declineRejection(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: any) {
    return this.service.declineRejection(id, req.user?.id, body?.note);
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
