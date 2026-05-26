import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';

@Injectable()
export class AllocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(query: any) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);
    const entityId = query.entityId ? Number(query.entityId) : undefined;
    const where = entityId ? { reservation: { item: { entityId } } } : undefined;

    const [data, total] = await Promise.all([
      this.prisma.reservationAllocation.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          asset: { include: { item: true } },
          reservation: { include: { item: true } },
        },
      }),
      this.prisma.reservationAllocation.count({ where }),
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

  // Fix #1: proper release with history entry and reservation status update
  async remove(id: number) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: { id },
      include: { reservation: true },
    });

    if (!allocation) {
      throw new NotFoundException('Allocation not found');
    }

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

      return { success: true };
    });
  }
}
