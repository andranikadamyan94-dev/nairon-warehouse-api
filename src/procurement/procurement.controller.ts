import {
  BadRequestException,
  Body, Controller, Delete, Get, Param, ParseIntPipe,
  Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors, Query,
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

@ApiTags('Procurement')
@Controller('procurement')
export class ProcurementController {
  constructor(private readonly procurementService: ProcurementService) {}

  @UseGuards(PermissionGuard)
  @Permissions('view_procurement', 'manage_procurement')
  @Get()
  @ApiOperation({ summary: 'Get all procurement orders' })
  findAll(@Query() query: any) { return this.procurementService.findAll(query); }

  // Receiving belongs to the warehouse side of the 2026-09-01 split: orders
  // the procurement side has confirmed (ORDERED) plus anything mid-delivery,
  // served to the Ընդունումներ page under warehouse permissions.
  // Deliberately NOT view_resources: receivable orders carry supplier names
  // and unit prices — broad viewers have no business seeing purchase terms.
  @UseGuards(PermissionGuard)
  @Permissions('manage_inventory', 'manage_warehouse')
  @Get('receivable')
  @ApiOperation({ summary: 'Orders awaiting or amid delivery (warehouse receiving list)' })
  findReceivable(@Query() query: any) { return this.procurementService.findReceivable(query); }

  @UseGuards(PermissionGuard)
  @Permissions('view_procurement', 'manage_procurement')
  @Get(':id')
  @ApiOperation({ summary: 'Get procurement order by id' })
  findOne(@Param('id', ParseIntPipe) id: number) { return this.procurementService.findOne(id); }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Post()
  @ApiOperation({ summary: 'Create procurement order' })
  create(@Body() dto: CreateProcurementDto, @LoggedInUser('id') userId?: number) {
    return this.procurementService.create(dto, userId);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id')
  @ApiOperation({ summary: 'Update procurement order' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateProcurementDto) {
    return this.procurementService.update(id, dto);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Patch(':id/order')
  @ApiOperation({ summary: 'Confirm the purchase — order placed with the supplier, hands off to warehouse receiving' })
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
      'Record a delivery — requires a receipt file. Send `lines` for a partial delivery; omit it to receive the whole outstanding remainder.',
  })
  receive(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() receipt: Express.Multer.File,
    @Body() body: { lines?: string | ReceiveDeliveryLineDto[]; notes?: string },
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
    return this.procurementService.receive(id, receipt, { lines, notes: body?.notes }, userId);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_inventory', 'manage_warehouse')
  @Patch(':id/close-short')
  @ApiOperation({
    summary: 'Settle a partially delivered order — the outstanding quantity is not coming',
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
    return this.procurementService.cancel(id, req.user?.id, !!req.isSuperAdmin, body?.reason);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Post(':id/finalize')
  @ApiOperation({ summary: 'Finalize order — sends to finance for approval' })
  finalize(@Param('id', ParseIntPipe) id: number) {
    return this.procurementService.finalize(id);
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
  @ApiOperation({ summary: 'Finance approval callback (called by finance API)' })
  financeCallback(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: { status: 'APPROVED' | 'REJECTED'; rejectionReason?: string },
  ) {
    return this.procurementService.financeCallback(id, body.status, body.rejectionReason);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_procurement')
  @Delete(':id')
  @ApiOperation({ summary: 'Delete procurement order' })
  remove(@Param('id', ParseIntPipe) id: number) { return this.procurementService.remove(id); }
}
