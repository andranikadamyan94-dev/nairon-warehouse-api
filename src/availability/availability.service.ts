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
    // #1989: which pool the request draws from — null/undefined = main
    // (Item.quantity), a project-warehouse id = its WarehouseStock row. Only
    // same-pool reservations compete.
    warehouseId?: number | null,
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

    const usableAssets = {
      itemId: item.id,
      // #1989 workspaces: only assets homed in the requesting pool count.
      warehouseId: warehouseId ?? null,
      status: { notIn: [AssetStatus.DAMAGED, AssetStatus.RETIRED] },
    };

    // Counts, not rows. This previously loaded every asset of the item with its
    // maintenance records included — and Prisma resolves an `include` as a
    // second query with one bind parameter per parent id. An item with 100k
    // assets (procurement creates one row per ordered unit) blew Postgres'
    // 32767-parameter ceiling and 500'd the whole availability check.
    //
    // Only two integers were ever derived from those rows, and
    // `maintenanceRecords: { some }` compiles to a correlated EXISTS, so there
    // is no id list at all — the limit becomes unreachable rather than merely
    // further away.
    const reservationWhere = {
      itemId: item.id,
      warehouseId: warehouseId ?? null,
      ...reservationOverlapFilter,
      status: { notIn: INACTIVE_STATUSES },
      ...(excludeTaskId ? { taskId: { not: excludeTaskId } } : {}),
    };

    const [assetCount, underMaintenance, overlappingReservations, handedOut] = await Promise.all([
      this.prisma.asset.count({ where: usableAssets }),
      this.prisma.asset.count({
        where: { ...usableAssets, maintenanceRecords: { some: maintenanceFilter } },
      }),
      this.prisma.resourceReservation.aggregate({
        where: reservationWhere,
        _sum: { quantity: true },
      }),
      // Approving a consumable already decrements Item.quantity, so the
      // handed-out share of a counted reservation is in the stock figure
      // too. Without crediting it back, every allocated consumable is
      // subtracted twice and updates knock delivered items back to PENDING.
      item.type === ItemType.ASSET
        ? Promise.resolve(null)
        : this.prisma.reservationAllocation.aggregate({
            where: { releasedAt: null, reservation: reservationWhere },
            _sum: { quantity: true },
          }),
    ]);

    let available: number;
    if (item.type === ItemType.ASSET) {
      available = assetCount;
    } else if (warehouseId) {
      const stock = await this.prisma.warehouseStock.findUnique({
        where: { warehouseId_itemId: { warehouseId, itemId: item.id } },
        select: { quantity: true },
      });
      available = stock?.quantity ?? 0;
    } else {
      available = item.quantity ?? 0;
    }

    available = Math.max(0, available - underMaintenance);
    const reservedSum = overlappingReservations._sum.quantity ?? 0;
    const alreadyInStockFigure = handedOut?._sum.quantity ?? 0;
    available = Math.max(0, available - Math.max(0, reservedSum - alreadyInStockFigure));

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
                dto.warehouseId,
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
            dto.warehouseId,
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
