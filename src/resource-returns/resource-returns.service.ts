import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';
import { ItemType } from '../common/enums/item-type.enum';
import { StockAlertService } from '../common/notifications/stock-alert.service';

/**
 * Returns keep their established meaning — the task gives back goods it HOLDS
 * and its request shrinks accordingly — rebuilt correctly (2026-09-02):
 * the cap is what was actually issued (the old cap against the requested
 * quantity let a task "return" goods never delivered, crediting stock from
 * thin air), releases walk every allocation row instead of one, partial asset
 * returns free only the returned count, and status/acceptance stay coherent.
 */
@Injectable()
export class ResourceReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockAlerts: StockAlertService,
  ) {}

  private readonly include = {
    reservation: {
      include: { item: true },
    },
  };

  /** Unreleased allocation quantity — what the task physically holds. */
  private async issuedOf(tx: any, reservationId: number): Promise<number> {
    const agg = await tx.reservationAllocation.aggregate({
      where: { reservationId, releasedAt: null },
      _sum: { quantity: true },
    });
    return agg._sum.quantity ?? 0;
  }

  async create(dto: CreateReturnDto) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: dto.reservationId },
      include: { item: true },
    });

    if (!reservation) throw new NotFoundException('Reservation not found');

    // You can only give back what you hold: issued minus what's already on
    // its way back. Applies to assets too — the old code had no asset cap.
    const issued = await this.issuedOf(this.prisma, dto.reservationId);
    const pendingQty = await this.prisma.resourceReturn.aggregate({
      where: { reservationId: dto.reservationId, status: ResourceReturnStatus.PENDING },
      _sum: { quantity: true },
    });
    const alreadyPending = pendingQty._sum.quantity ?? 0;
    const returnable = issued - alreadyPending;
    if (dto.quantity > returnable) {
      throw new BadRequestException(
        `Վերադարձվող քանակը (${dto.quantity}) գերազանցում է տրամադրված մնացորդը (${Math.max(0, returnable)})`,
      );
    }

    return this.prisma.resourceReturn.create({
      data: {
        reservationId: dto.reservationId,
        quantity: dto.quantity,
        notes: dto.notes ?? null,
        requestedBy: dto.requestedBy ?? null,
      },
      include: this.include,
    });
  }

  findAll(filters: { status?: ResourceReturnStatus; taskId?: number }) {
    return this.prisma.resourceReturn.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.taskId ? { reservation: { taskId: filters.taskId } } : {}),
      },
      include: this.include,
      orderBy: { requestedAt: 'desc' },
    });
  }

  async receive(id: number, receivedBy?: number) {
    const ret = await this.prisma.resourceReturn.findUnique({
      where: { id },
      include: { reservation: { include: { item: true } } },
    });

    if (!ret) throw new NotFoundException('Return not found');
    if (ret.status !== ResourceReturnStatus.PENDING) {
      throw new BadRequestException('Return is not in PENDING status');
    }

    const isAsset = ret.reservation.item.type === ItemType.ASSET;

    const result = await this.prisma.$transaction(async (tx) => {
      // The world may have moved since the return was requested (reclaims,
      // further acceptance) — never take back more than is out right now.
      const issued = await this.issuedOf(tx, ret.reservationId);
      if (ret.quantity > issued) {
        throw new BadRequestException(
          `Վերադարձի քանակը (${ret.quantity}) գերազանցում է այս պահին տրամադրվածը (${issued}) — չեղարկեք և կրկին ձևակերպեք`,
        );
      }

      // Release exactly the returned quantity, newest allocations first,
      // splitting a row when only part of it comes back — every released
      // unit stays a real, dated row.
      const active = await tx.reservationAllocation.findMany({
        where: { reservationId: ret.reservationId, releasedAt: null },
        orderBy: { id: 'desc' },
      });
      let remaining = ret.quantity;
      for (const alloc of active) {
        if (remaining <= 0) break;
        const rowQty = alloc.quantity ?? 1;
        const take = Math.min(rowQty, remaining);
        if (take === rowQty) {
          await tx.reservationAllocation.update({
            where: { id: alloc.id },
            data: { releasedAt: new Date() },
          });
        } else {
          await tx.reservationAllocation.update({
            where: { id: alloc.id },
            data: { quantity: rowQty - take },
          });
          await tx.reservationAllocation.create({
            data: { reservationId: ret.reservationId, quantity: take, releasedAt: new Date() },
          });
        }
        remaining -= take;
      }
      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: ret.reservationId,
          action: 'RELEASED',
          performedBy: receivedBy,
          notes: `Վերադարձ #${ret.id} ստացված — ${ret.quantity} հատ`,
        },
      });

      const newIssued = issued - ret.quantity;
      const prevStatus = ret.reservation.status as ResourceReservationStatus;
      let newStatus: ResourceReservationStatus;
      let dataPatch: any;

      if (isAsset) {
        // Individually tracked: freeing the returned units is the whole story.
        // COMPLETED only when nothing is out — a partial return must NOT make
        // the still-out units look available.
        newStatus = newIssued === 0
          ? ResourceReservationStatus.COMPLETED
          : ResourceReservationStatus.PARTIALLY_ALLOCATED;
        dataPatch = { status: newStatus };
      } else {
        // #1989: credit the pool the goods were issued from.
        const whId = (ret.reservation as any).warehouseId as number | null;
        if (whId) {
          await tx.warehouseStock.upsert({
            where: { warehouseId_itemId: { warehouseId: whId, itemId: ret.reservation.itemId } },
            update: { quantity: { increment: ret.quantity } },
            create: { warehouseId: whId, itemId: ret.reservation.itemId, quantity: ret.quantity },
          });
        } else {
          await tx.item.update({
            where: { id: ret.reservation.itemId },
            data: { quantity: { increment: ret.quantity } },
          });
        }

        // The request shrinks by what came back; acceptance can never exceed
        // either the new request or what is still out.
        const newQuantity = Math.max(0, ret.reservation.quantity - ret.quantity);
        const accepted = (ret.reservation as any).acceptedQuantity ?? 0;
        // Returned goods are no longer kept: acceptance can exceed neither the
        // shrunken request nor what is still physically out.
        const newAccepted = Math.min(accepted, newQuantity, newIssued);

        if (newQuantity === 0 || newAccepted >= newQuantity) {
          newStatus = ResourceReservationStatus.COMPLETED;
        } else if (newIssued >= newQuantity) {
          newStatus = ResourceReservationStatus.ALLOCATED;
        } else if (newIssued > 0 || newAccepted > 0) {
          newStatus = ResourceReservationStatus.PARTIALLY_ALLOCATED;
        } else {
          newStatus = ResourceReservationStatus.APPROVED;
        }
        dataPatch = { quantity: newQuantity, acceptedQuantity: newAccepted, status: newStatus };
      }

      await tx.resourceReservation.update({
        where: { id: ret.reservationId },
        data: dataPatch,
      });
      if (newStatus !== prevStatus) {
        await tx.reservationStatusHistory.create({
          data: {
            reservationId: ret.reservationId,
            fromStatus: prevStatus,
            toStatus: newStatus,
            performedBy: receivedBy,
            reason: `Վերադարձ #${ret.id} ստացված`,
          },
        });
      }

      await tx.inventoryMovement.create({
        data: {
          itemId: ret.reservation.itemId,
          quantity: ret.quantity,
          type: 'IN',
          taskId: ret.reservation.taskId,
          warehouseId: (ret.reservation as any).warehouseId ?? null,
          performedBy: receivedBy,
          notes: `Վերադարձ #${ret.id} ստացված`,
        },
      });

      return tx.resourceReturn.update({
        where: { id },
        data: {
          status: ResourceReturnStatus.RECEIVED,
          receivedBy: receivedBy ?? null,
          receivedAt: new Date(),
        },
        include: this.include,
      });
    });

    if (!isAsset) this.stockAlerts.check([ret.reservation.itemId]);

    return result;
  }

  async cancel(id: number) {
    const ret = await this.prisma.resourceReturn.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException('Return not found');
    if (ret.status !== ResourceReturnStatus.PENDING) {
      throw new BadRequestException('Only pending returns can be cancelled');
    }

    return this.prisma.resourceReturn.update({
      where: { id },
      data: { status: ResourceReturnStatus.CANCELLED },
      include: this.include,
    });
  }
}
