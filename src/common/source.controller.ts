import { Controller, Get, NotFoundException, Param, ParseIntPipe, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from 'prisma/prisma.service';
import { Public } from '../auth/decorators/public.decorator';
import { InternalGuard } from '../auth/guards/internal.guard';

/**
 * The uniform "is this settled?" contract finance calls before booking money
 * against something this service owns.
 *
 * Finance used to hardcode procurement's status vocabulary. Answering here
 * instead keeps that knowledge where the statuses are defined, and lets any
 * new kind participate by adding a case rather than by editing finance.
 *
 * Settled means the amount is final — not that it was paid.
 */
@ApiTags('Internal')
@Controller('internal/source')
export class SourceController {
  constructor(private prisma: PrismaService) {}

  /** Delivered quantity is fixed once the order is closed one way or another. */
  private static readonly PROCUREMENT_SETTLED = ['RECEIVED', 'CLOSED_SHORT', 'CANCELLED'];

  @Public()
  @UseGuards(InternalGuard)
  @Get(':kind/:id')
  @ApiOperation({ summary: 'Settlement state of a warehouse-owned source (internal)' })
  async status(@Param('kind') kind: string, @Param('id', ParseIntPipe) id: number) {
    if (kind === 'procurement') {
      const order = await this.prisma.procurementOrder.findUnique({
        where: { id },
        select: { status: true, items: { select: { quantity: true, unitPrice: true, receivedQuantity: true } } },
      });
      if (!order) throw new NotFoundException();
      const finalAmount = order.items.reduce(
        (sum, i) => sum + (i.receivedQuantity ?? 0) * (i.unitPrice ?? 0),
        0,
      );
      return {
        status: order.status,
        settled: SourceController.PROCUREMENT_SETTLED.includes(order.status),
        finalAmount,
      };
    }

    // Maintenance is deliberately not gated. It never was, and making its
    // payments conditional on the job being COMPLETED would be a new
    // restriction on finance that nobody asked for — a refactor should not
    // change behaviour. Adding a case here is all it would take.
    //
    // Unknown kind: 404 tells finance this service does not gate it, which it
    // treats as "nothing to enforce" rather than as a failure.
    throw new NotFoundException();
  }
}
