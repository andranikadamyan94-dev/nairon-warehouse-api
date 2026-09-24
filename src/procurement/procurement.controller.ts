import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Query,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ProcurementService } from './procurement.service';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { ProcurementOrderStatus } from '../common/enums/procurement-order-status.enum';
import { Public } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { LoggedInUser } from '../auth/decorators/logged-in-user.decorator';
import { ReceiveDeliveryLineDto } from './dto/receive-delivery.dto';
import { AmendProcurementDto } from './dto/amend-procurement.dto';

@ApiTags('Procurement')
@Controller('procurement')
export class ProcurementController {
  constructor(private readonly procurementService: ProcurementService) {}

  @UseGuards(PermissionGuard)
  // receive_procurement_alerts: the people the alerts are sent to must be able
  // to open what the alert links to (read only — writes stay with manage_*).
  @Permissions(
    'view_procurement',
    'manage_procurement',
    'receive_procurement_alerts',
    // 2026-09-25: the people who approve orders before finance read them here.
    'approve_purchase_order',
  )
  @Get()
  @ApiOperation({ summary: 'Get all procurement orders' })
  findAll(@Query() query: any) {
    return this.procurementService.findAll(query);
  }

  // Receiving belongs to the warehouse side of the 2026-09-01 split: orders
  // the procurement side has confirmed (ORDERED) plus anything mid-delivery,
  // served to the Ընդունումներ page under warehouse permissions.
  // Deliberately NOT view_resources: receivable orders carry supplier names
  // and unit prices — broad viewers have no business seeing purchase terms.
  @UseGuards(PermissionGuard)
  @Permissions('manage_inventory', 'manage_warehouse')
  @Get('receivable')
  @ApiOperation({
    summary: 'Orders awaiting or amid delivery (warehouse receiving list)',
  })
  findReceivable(@Query() query: any) {
    return this.procurementService.findReceivable(query);
  }

  @UseGuards(PermissionGuard)
  @Permissions(
    'view_procurement',
    'manage_procurement',
    'receive_procurement_alerts',
    // 2026-09-25: the people who approve orders before finance read them here.
    'approve_purchase_order',
  )
  @Get(':id')
  @ApiOperation({ summary: 'Get procurement order by id' })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.findOne(id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Post()
  @ApiOperation({ summary: 'Create procurement order' })
  create(
    @Body() dto: CreateProcurementDto,
    @LoggedInUser('id') userId?: number,
    @Req() req?: any,
  ) {
    const active = Number(req?.headers?.['x-entity-id'] ?? 0);
    return this.procurementService.create(
      dto,
      userId,
      active > 0 ? active : null,
    );
  }

  /**
   * Change which organization an order was bought for. Super-admins only —
   * this is the correction tool for orders placed before orders carried an
   * organization at all. The order's finance transfers follow, unless they
   * are already booked.
   */
  // The guard only resolves who the caller is when a route names permissions,
  // so this one asks for the procurement permission and the service then
  // insists on a super-admin.
  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/entity')
  @ApiOperation({
    summary: 'Re-file an order under another organization (super-admin)',
  })
  setEntity(
    @Param('id', ParseIntPipe) id: number,
    @Body('entityId') entityId: number | null,
    @Req() req: any,
  ) {
    return this.procurementService.setEntity(
      id,
      entityId ?? null,
      !!req.isSuperAdmin,
    );
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id')
  @ApiOperation({
    summary:
      'Update procurement order. A settled order (received / closed short) yields only to a super-admin, and then only its supplier, note and line prices.',
  })
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateProcurementDto,
    @Req() req: any,
    @LoggedInUser('id') userId?: number,
  ) {
    return this.procurementService.update(id, dto, {
      isSuperAdmin: !!req.isSuperAdmin,
      userId,
    });
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/order')
  @ApiOperation({
    summary:
      'Confirm the purchase — order placed with the supplier, hands off to warehouse receiving',
  })
  markOrdered(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.confirmOrdered(id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_inventory', 'manage_warehouse')
  @Patch(':id/receive')
  @UseInterceptors(FileInterceptor('receipt'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary:
      'Record a delivery — requires a document number; the receipt file is optional. Send `lines` for a partial delivery; omit it to receive the whole outstanding remainder.',
  })
  receive(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() receipt: Express.Multer.File | undefined,
    @Body()
    body: {
      lines?: string | ReceiveDeliveryLineDto[];
      notes?: string;
      documentNumber?: string;
    },
    @LoggedInUser('id') userId?: number,
  ) {
    // multipart carries everything as strings, so a per-line array arrives
    // JSON-encoded rather than as a real array.
    let lines: ReceiveDeliveryLineDto[] | undefined;
    if (typeof body?.lines === 'string' && body.lines.trim()) {
      try {
        lines = JSON.parse(body.lines);
      } catch {
        throw new BadRequestException('`lines` must be valid JSON');
      }
    } else if (Array.isArray(body?.lines)) {
      lines = body.lines;
    }
    return this.procurementService.receive(
      id,
      receipt,
      { lines, notes: body?.notes, documentNumber: body?.documentNumber },
      userId,
    );
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_inventory', 'manage_warehouse')
  @Patch(':id/close-short')
  @ApiOperation({
    summary:
      'Settle a partially delivered order — the outstanding quantity is not coming',
  })
  closeShort(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { reason?: string },
  ) {
    return this.procurementService.closeShort(id, body?.reason);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/cancel')
  @ApiOperation({
    summary:
      'Cancel procurement order — creator (or super-admin) only; voids the finance transfers and, mid-delivery, settles the remainder short instead',
  })
  cancel(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { reason?: string },
    @Req() req: any,
  ) {
    return this.procurementService.cancel(
      id,
      req.user?.id,
      !!req.isSuperAdmin,
      body?.reason,
    );
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Post(':id/finalize')
  @ApiOperation({ summary: 'Send a draft order for approval (approve_purchase_order) — finance hears of it once approved' })
  finalize(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.procurementService.finalize(id, req.user?.id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('approve_purchase_order')
  @Post(':id/approve')
  @ApiOperation({ summary: 'Approve a pending order — raises it with finance' })
  approve(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.procurementService.approve(id, req.user?.id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('approve_purchase_order')
  @Post(':id/reject-approval')
  @ApiOperation({ summary: 'Send a pending order back to draft with a reason' })
  rejectApproval(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: any) {
    return this.procurementService.rejectApproval(id, req.user?.id, body?.reason);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Post(':id/resubmit')
  @ApiOperation({ summary: 'Resubmit a finance-rejected order back to DRAFT' })
  resubmit(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.resubmit(id);
  }

  @Public()
  @UseGuards(InternalGuard)
  @Get(':id/internal')
  @ApiOperation({ summary: 'Get procurement order details (internal)' })
  findOneInternal(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.findOne(id);
  }

  @Public()
  @UseGuards(InternalGuard)
  @Post(':id/finance-callback')
  @ApiOperation({
    summary: 'Finance approval callback (called by finance API)',
  })
  financeCallback(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    body: {
      status: 'APPROVED' | 'REJECTED';
      rejectionReason?: string;
      transferId?: number;
    },
  ) {
    return this.procurementService.financeCallback(
      id,
      body.status,
      body.rejectionReason,
      body.transferId,
    );
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/amend')
  @ApiOperation({
    summary:
      "Correct the prices of a received order to the supplier's invoice (2026-09-22). The difference goes to finance as an adjustment or a refund through the normal approval.",
  })
  amend(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: AmendProcurementDto,
    @LoggedInUser('id') userId?: number,
  ) {
    return this.procurementService.amend(id, dto, userId);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Delete(':id')
  @ApiOperation({ summary: 'Delete procurement order' })
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.remove(id);
  }
}
