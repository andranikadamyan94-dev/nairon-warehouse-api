import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { ItemType } from '../common/enums/item-type.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';

@Injectable()
export class AllocationsService {
  /** #2042: reverse flows mirror the ISSUANCE — frozen cost AND object.
   *  taskId null matches only task-less rows (undefined would drop the filter). */
  private async reverseCostInfo(
    tx: any,
    args: { taskId?: number | null; itemId: number; warehouseId?: number | null; fallbackObjectId?: number | null },
  ): Promise<{ unitCost: number | null; objectId: number | null }> {
    const lastOut = await tx.inventoryMovement.findFirst({
      where: {
        type: 'OUT',
        itemId: args.itemId,
        taskId: args.taskId ?? null,
        warehouseId: args.warehouseId ?? null,
      },
      orderBy: { id: 'desc' },
      select: { unitCost: true, objectId: true },
    });
    let unitCost = lastOut?.unitCost ?? null;
    if (unitCost == null) {
      const item = await tx.item.findUnique({ where: { id: args.itemId }, select: { unitCost: true } });
      unitCost = item?.unitCost ?? null;
    }
    return {
      unitCost,
      objectId: lastOut ? (lastOut.objectId ?? null) : (args.fallbackObjectId ?? null),
    };
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly stockAlerts: StockAlertService,
  ) {}

  async getAll(query: any) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);
    const [data, total] = await Promise.all([
      this.prisma.reservationAllocation.findMany({
        // Paging with no ordering at all leaves the arrangement entirely up to
        // Postgres, so skip/take could return the same allocation on two pages
        // and never show another.
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        where: { releasedAt: null },
        include: {
          asset: { include: { item: true } },
          reservation: { include: { item: true } },
        },
      }),
      this.prisma.reservationAllocation.count({ where: { releasedAt: null } }),
    ]);

    return { data, total, page, limit };
  }

  async getOne(id: number) {
    return this.prisma.reservationAllocation.findUnique({
      where: { id },
      include: {
        asset: { include: { item: true } },
        reservation: { include: { item: true } },
      },
    });
  }

  async returnAllocations(returns: { allocationId: number; quantity?: number }[]) {
    const touchedItemIds: number[] = [];
    const result = await this.prisma.$transaction(async (tx) => {
      for (const entry of returns) {
        const allocation = await tx.reservationAllocation.findUnique({
          where: { id: entry.allocationId },
          include: { reservation: { include: { item: true } } },
        });

        if (!allocation || allocation.releasedAt) {
          throw new NotFoundException(`Allocation ${entry.allocationId} not found or already released`);
        }

        const isConsumable = allocation.reservation.item.type === ItemType.CONSUMABLE;
        const returnQty = entry.quantity ?? allocation.quantity;

        if (entry.quantity !== undefined && entry.quantity > allocation.quantity) {
          throw new BadRequestException(
            `Cannot return ${entry.quantity} units — allocation only contains ${allocation.quantity}`,
          );
        }

        if (isConsumable) {
          const remaining = allocation.quantity - returnQty;

          if (remaining <= 0) {
            await tx.reservationAllocation.update({
              where: { id: allocation.id },
              data: { releasedAt: new Date() },
            });
          } else {
            await tx.reservationAllocation.update({
              where: { id: allocation.id },
              data: { quantity: remaining },
            });
          }

          // #1989: credit the pool the goods were issued from.
          const whId = (allocation.reservation as any).warehouseId as number | null;
          if (whId) {
            await tx.warehouseStock.upsert({
              where: { warehouseId_itemId: { warehouseId: whId, itemId: allocation.reservation.itemId } },
              update: { quantity: { increment: returnQty } },
              create: { warehouseId: whId, itemId: allocation.reservation.itemId, quantity: returnQty },
            });
          } else {
            await tx.item.update({
              where: { id: allocation.reservation.itemId },
              data: { quantity: { increment: returnQty } },
            });
          }
          touchedItemIds.push(allocation.reservation.itemId);

          const rc = await this.reverseCostInfo(tx, {
            taskId: allocation.reservation.taskId,
            itemId: allocation.reservation.itemId,
            warehouseId: whId,
            fallbackObjectId: (allocation.reservation as any).objectId ?? null,
          });
          await tx.inventoryMovement.create({
            data: {
              itemId: allocation.reservation.itemId,
              quantity: returnQty,
              type: 'IN',
              taskId: allocation.reservation.taskId,
              warehouseId: whId,
              objectId: rc.objectId,
              unitCost: rc.unitCost,
              totalCost: rc.unitCost != null ? returnQty * rc.unitCost : null,
              notes: `Վերադարձ ամրագրում #${allocation.reservationId}-ից`,
            },
          });
        } else {
          // Asset: always release the full allocation row (1 asset per row)
          await tx.reservationAllocation.update({
            where: { id: allocation.id },
            data: { releasedAt: new Date() },
          });
        }

        await tx.reservationAllocationHistory.create({
          data: {
            reservationId: allocation.reservationId,
            assetId: allocation.assetId,
            action: 'RETURNED',
            notes: `${returnQty} հատ վերադարձվել է պահեստ`,
          },
        });

        // Decrement reservation.quantity and keep status ALLOCATED
        await tx.resourceReservation.update({
          where: { id: allocation.reservationId },
          data: { quantity: { decrement: returnQty } },
        });
      }

      return { success: true };
    });

    // Stock only goes up here, so this can't breach a threshold — but it can
    // clear the latch so the next genuine breach alerts again.
    this.stockAlerts.check(touchedItemIds);

    return result;
  }

  async remove(id: number) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: { id },
      include: { reservation: { include: { item: true } } },
    });

    if (!allocation) throw new NotFoundException('Allocation not found');

    const isConsumable = allocation.reservation.item.type === ItemType.CONSUMABLE;

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.reservationAllocation.update({
        where: { id },
        data: { releasedAt: new Date() },
      });

      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: allocation.reservationId,
          assetId: allocation.assetId,
          action: 'RELEASED',
        },
      });

      if (isConsumable) {
        // #1989: credit the pool the goods were issued from.
        const whId = (allocation.reservation as any).warehouseId as number | null;
        if (whId) {
          await tx.warehouseStock.upsert({
            where: { warehouseId_itemId: { warehouseId: whId, itemId: allocation.reservation.itemId } },
            update: { quantity: { increment: allocation.quantity } },
            create: { warehouseId: whId, itemId: allocation.reservation.itemId, quantity: allocation.quantity },
          });
        } else {
          await tx.item.update({
            where: { id: allocation.reservation.itemId },
            data: { quantity: { increment: allocation.quantity } },
          });
        }

        const rel = await this.reverseCostInfo(tx, {
          taskId: allocation.reservation.taskId,
          itemId: allocation.reservation.itemId,
          warehouseId: whId,
          fallbackObjectId: (allocation.reservation as any).objectId ?? null,
        });
        await tx.inventoryMovement.create({
          data: {
            itemId: allocation.reservation.itemId,
            quantity: allocation.quantity,
            type: 'IN',
            taskId: allocation.reservation.taskId,
            warehouseId: whId,
            objectId: rel.objectId,
            unitCost: rel.unitCost,
            totalCost: rel.unitCost != null ? allocation.quantity * rel.unitCost : null,
            notes: `Ամրագրում #${allocation.reservationId} — հատկացումը չեղարկված`,
          },
        });

        await tx.resourceReservation.update({
          where: { id: allocation.reservationId },
          data: { status: ResourceReservationStatus.PENDING },
        });
      } else {
        const activeAllocationCount = await tx.reservationAllocation.count({
          where: { reservationId: allocation.reservationId, releasedAt: null },
        });

        await tx.resourceReservation.update({
          where: { id: allocation.reservationId },
          data: {
            status:
              activeAllocationCount === 0
                ? ResourceReservationStatus.APPROVED
                : ResourceReservationStatus.PARTIALLY_ALLOCATED,
          },
        });
      }

      return { success: true };
    });

    if (isConsumable) this.stockAlerts.check([allocation.reservation.itemId]);

    return result;
  }
}