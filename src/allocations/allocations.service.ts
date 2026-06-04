import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';
import { ItemType } from '../common/enums/item-type.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';

@Injectable()
export class AllocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(query: any) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);
    const [data, total] = await Promise.all([
      this.prisma.reservationAllocation.findMany({
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
    return this.prisma.$transaction(async (tx) => {
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

          await tx.item.update({
            where: { id: allocation.reservation.itemId },
            data: { quantity: { increment: returnQty } },
          });

          await tx.inventoryMovement.create({
            data: {
              itemId: allocation.reservation.itemId,
              quantity: returnQty,
              type: 'IN',
              taskId: allocation.reservation.taskId,
              notes: `Returned from reservation #${allocation.reservationId}`,
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
            notes: `Returned ${returnQty} unit(s) to warehouse`,
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
  }

  async remove(id: number) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: { id },
      include: { reservation: { include: { item: true } } },
    });

    if (!allocation) throw new NotFoundException('Allocation not found');

    const isConsumable = allocation.reservation.item.type === ItemType.CONSUMABLE;

    return this.prisma.$transaction(async (tx) => {
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
        await tx.item.update({
          where: { id: allocation.reservation.itemId },
          data: { quantity: { increment: allocation.quantity } },
        });

        await tx.inventoryMovement.create({
          data: {
            itemId: allocation.reservation.itemId,
            quantity: allocation.quantity,
            type: 'IN',
            taskId: allocation.reservation.taskId,
            notes: `Reservation #${allocation.reservationId} allocation cancelled`,
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
  }
}