import { Injectable } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { AssetStatus } from '../common/enums/asset-status.enum';
import { ItemType } from '../common/enums/item-type.enum';
import { ItemUnit } from '../common/enums/item-unit.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';
import { splitIntoWorkingDaySlots } from '../common/utils/date.utils';

import { CheckAvailabilityDto } from './dto/check-availability.dto';

const INACTIVE_STATUSES = [
  ResourceReservationStatus.CANCELLED,
  ResourceReservationStatus.COMPLETED,
  ResourceReservationStatus.REJECTED,
];

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Check available quantity for a single time window.
   * Shared by both standard and per-day hourly checks.
   */
  private async checkWindow(
    item: { id: number; type: string; quantity: number; unit: string | null },
    startDate: Date,
    endDate: Date | null,
    excludeTaskId?: number,
  ): Promise<number> {
    // Open-ended reservations (endDate = null) conflict with any window that starts after them.
    // For bounded windows, also include open-ended reservations that started before the window ends.
    const reservationOverlapFilter = endDate
      ? {
          OR: [
            { endDate: null, startDate: { lte: endDate } },
            { startDate: { lte: endDate }, endDate: { gte: startDate } },
          ],
        }
      : { startDate: { lte: startDate } }; // open-ended request: only open-ended existing ones conflict

    const maintenanceFilter = endDate
      ? { startDate: { lte: endDate }, endDate: { gte: startDate } }
      : { startDate: { gte: startDate } };

    const [assets, overlappingReservations] = await Promise.all([
      this.prisma.asset.findMany({
        where: {
          itemId: item.id,
          status: { notIn: [AssetStatus.DAMAGED, AssetStatus.RETIRED] },
        },
        include: {
          maintenanceRecords: {
            where: maintenanceFilter,
          },
        },
      }),
      this.prisma.resourceReservation.aggregate({
        where: {
          itemId: item.id,
          ...reservationOverlapFilter,
          status: { notIn: INACTIVE_STATUSES },
          ...(excludeTaskId ? { taskId: { not: excludeTaskId } } : {}),
        },
        _sum: { quantity: true },
      }),
    ]);

    let available =
      item.type === ItemType.ASSET ? assets.length : (item.quantity ?? 0);

    const underMaintenance = assets.filter(
      (a) => a.maintenanceRecords.length > 0,
    ).length;

    available = Math.max(0, available - underMaintenance);
    available = Math.max(
      0,
      available - (overlappingReservations._sum.quantity ?? 0),
    );

    return available;
  }

  async checkAvailability(dto: CheckAvailabilityDto) {
    const unavailableResources: {
      itemId: number;
      available: number;
      requested: number;
      date?: string;
    }[] = [];

    await Promise.all(
      dto.resources.map(async (requestedResource) => {
        const item = await this.prisma.item.findUnique({
          where: { id: requestedResource.itemId },
        });

        if (!item) return;

        const endDate = dto.endDate ? new Date(dto.endDate) : null;

        if (item.unit === ItemUnit.HOUR && endDate) {
          // Per-day check: each day is an independent availability window (not valid open-ended)
          const customTime =
            requestedResource.startTime && requestedResource.endTime
              ? {
                  startHour: parseInt(requestedResource.startTime.split(':')[0], 10),
                  startMinute: parseInt(requestedResource.startTime.split(':')[1], 10),
                  endHour: parseInt(requestedResource.endTime.split(':')[0], 10),
                  endMinute: parseInt(requestedResource.endTime.split(':')[1], 10),
                }
              : undefined;
          const slots = splitIntoWorkingDaySlots(dto.startDate, dto.endDate, customTime);

          await Promise.all(
            slots.map(async (slot) => {
              const available = await this.checkWindow(
                item,
                slot.startDate,
                slot.endDate,
                dto.excludeTaskId,
              );

              if (available < requestedResource.quantity) {
                unavailableResources.push({
                  itemId: requestedResource.itemId,
                  date: slot.yerevanDate,
                  available,
                  requested: requestedResource.quantity,
                });
              }
            }),
          );
        } else {
          // Standard single-window check (including open-ended: endDate = null)
          const available = await this.checkWindow(
            item,
            new Date(dto.startDate),
            endDate,
            dto.excludeTaskId,
          );

          if (available < requestedResource.quantity) {
            unavailableResources.push({
              itemId: requestedResource.itemId,
              available,
              requested: requestedResource.quantity,
            });
          }
        }
      }),
    );

    return {
      available: unavailableResources.length === 0,
      unavailableResources,
    };
  }
}
