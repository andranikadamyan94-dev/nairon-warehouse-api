import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';

import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { StockRequestsService } from './stock-requests.service';
import { PermissionGuard, Permissions } from '../auth/guards/permission.guard';
import { PREFLIGHT_OK } from '../common/preflight/preflight';
import { OperationsService } from '../common/operations/operations.service';
import { OperationKey } from '../common/operations/operation-key.decorator';

// When PermissionGuard didn't run, pass undefined so the service resolves
// access info itself instead of trusting an empty permission list.
const ctxOf = (req: any) =>
  req.permissionNames
    ? { isSuperAdmin: !!req.isSuperAdmin, permissionNames: req.permissionNames }
    : undefined;

@ApiTags('Stock requests')
@Controller('stock-requests')
export class StockRequestsController {
  constructor(
    private readonly stockRequestsService: StockRequestsService,
    private readonly operations: OperationsService,
  ) {}

  // Membership is the gate here, enforced in the service — a sub's staff may
  // file/see THEIR warehouse's requests regardless of stock permissions.
  @Get()
  @ApiOperation({ summary: 'Stock requests (sub view or main queue)' })
  findAll(@Query() query: any, @Req() req: any) {
    return this.stockRequestsService.findAll(query, req.user?.id, ctxOf(req));
  }

  /**
   * Asking twice asks main for twice the stock. With an `Idempotency-Key` a
   * repeated attempt replays the first instead of filing again — see
   * OperationsService. `req.actor` is the one AuthGuard resolved.
   */
  @Post()
  @ApiOperation({ summary: 'File a resource request to main' })
  async create(@Body() dto: any, @Req() req: any, @OperationKey() operationKey?: string) {
    const { result } = await this.operations.runOnce(
      { key: operationKey, actor: req.actor, route: 'POST /stock-requests', body: dto },
      (tx) => this.stockRequestsService.create(dto, req.user?.id, ctxOf(req), tx),
    );
    return result;
  }

  /**
   * Would this request be accepted? Same gate as create — a PROJECT warehouse
   * the caller belongs to, active, valid lines — and nothing written.
   * See src/common/preflight/preflight.ts.
   */
  @Post('preflight/create')
  @ApiOperation({ summary: 'Preflight: may this person file this resource request, and what would it be?' })
  async preflightCreate(@Body() dto: any, @Req() req: any) {
    return { ...PREFLIGHT_OK, request: await this.stockRequestsService.previewCreate(dto, req.user?.id, ctxOf(req)) };
  }

  // Requester or main-side staff edit a pending request (guarded in the
  // service — same audience approve() trusts, plus the creator).
  @Patch(':id')
  @ApiOperation({ summary: 'Edit a pending request (lines/comment)' })
  update(@Param('id', ParseIntPipe) id: number, @Body() dto: any, @Req() req: any) {
    return this.stockRequestsService.update(id, dto, req.user?.id, ctxOf(req));
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_stock_transfers')
  @Patch(':id/approve')
  @ApiOperation({ summary: 'Approve — executes the transfer' })
  approve(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.stockRequestsService.approve(id, req.user?.id);
  }

  @UseGuards(PermissionGuard)
  @Permissions('manage_stock_transfers')
  @Patch(':id/reject')
  @ApiOperation({ summary: 'Reject with a reason' })
  reject(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: any) {
    return this.stockRequestsService.reject(id, req.user?.id, body?.reason);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Requester withdraws a pending request' })
  async cancel(@Param('id', ParseIntPipe) id: number, @Req() req: any) {
    return this.stockRequestsService.cancel(id, req.user?.id, !!req.isSuperAdmin);
  }
}
