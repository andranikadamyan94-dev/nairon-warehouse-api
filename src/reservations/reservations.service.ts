import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { AvailabilityService } from '../availability/availability.service';

import { AssetStatus } from '../common/enums/asset-status.enum';
import { ItemType } from '../common/enums/item-type.enum';
import { ItemUnit } from '../common/enums/item-unit.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';
import {
  splitIntoWorkingDaySlots,
  getYerevanDateKey,
  DaySlot,
} from '../common/utils/date.utils';

import { CreateReservationDto } from './dto/create-reservation.dto';
import { AllocateReservationDto } from './dto/allocate-reservation.dto';
import { ReallocateResourceDto } from './dto/reallocate-resource.dto';

const INACTIVE_STATUSES = [
  ResourceReservationStatus.CANCELLED,
  ResourceReservationStatus.COMPLETED,
];

// Fix #3: only these statuses allow allocation
const ALLOCATABLE_STATUSES = [
  ResourceReservationStatus.APPROVED,
  ResourceReservationStatus.PARTIALLY_ALLOCATED,
];

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly availabilityService: AvailabilityService,
  ) {}

  async create(dto: CreateReservationDto) {
    // Fetch item units to determine which resources need hourly logic
    const itemIds = dto.resources.map((r) => r.itemId);
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, unit: true },
    });
    const itemUnitMap = new Map(items.map((i) => [i.id, i.unit]));

    // Pre-generate day slots for HOUR items (validates times, throws BadRequestException if invalid)
    const hourlySlots = new Map<number, DaySlot[]>();
    for (const resource of dto.resources) {
      if (itemUnitMap.get(resource.itemId) === ItemUnit.HOUR) {
        hourlySlots.set(
          resource.itemId,
          splitIntoWorkingDaySlots(dto.startDate, dto.endDate),
        );
      }
    }

    const availability = await this.availabilityService.checkAvailability(dto);
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    await this.prisma.$transaction(async (tx) => {
      for (const resource of dto.resources) {
        const slots = hourlySlots.get(resource.itemId);

        if (slots) {
          // HOUR item: one reservation row per working day
          for (const slot of slots) {
            const isUnavailable = availability.unavailableResources.some(
              (r) => r.itemId === resource.itemId && r.date === slot.yerevanDate,
            );
            await tx.resourceReservation.create({
              data: {
                itemId: resource.itemId,
                quantity: resource.quantity,
                taskId: dto.taskId,
                startDate: slot.startDate,
                endDate: slot.endDate,
                status: isUnavailable
                  ? ResourceReservationStatus.PENDING
                  : ResourceReservationStatus.APPROVED,
              },
            });
          }
        } else {
          // Standard item: one reservation row for the full date range
          const isUnavailable = availability.unavailableResources.some(
            (r) => r.itemId === resource.itemId && !r.date,
          );
          await tx.resourceReservation.create({
            data: {
              itemId: resource.itemId,
              quantity: resource.quantity,
              taskId: dto.taskId,
              startDate,
              endDate,
              status: isUnavailable
                ? ResourceReservationStatus.PENDING
                : ResourceReservationStatus.APPROVED,
            },
          });
        }
      }
    });

    if (availability.unavailableResources.length) {
      console.log('WAREHOUSE_ADMIN_NOTIFICATION', {
        taskId: dto.taskId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        unavailableResources: availability.unavailableResources,
      });
    }

    return {
      available: availability.unavailableResources.length === 0,
      unavailableResources: availability.unavailableResources,
    };
  }

  async allocate(dto: AllocateReservationDto, allocatedBy?: number) {
    return this.prisma.$transaction(async (tx) => {
      for (const allocation of dto.allocations) {
        const reservation = await tx.resourceReservation.findUnique({
          where: { id: allocation.reservationId },
        });

        if (!reservation) {
          throw new NotFoundException('Reservation not found');
        }

        // Fix #3: guard against invalid statuses
        if (!ALLOCATABLE_STATUSES.includes(reservation.status as ResourceReservationStatus)) {
          throw new BadRequestException(
            `Reservation ${reservation.id} has status ${reservation.status} and cannot be allocated`,
          );
        }

        const asset = await tx.asset.findUnique({
          where: { id: allocation.assetId },
        });

        if (!asset) {
          throw new NotFoundException('Asset not found');
        }

        if (asset.status !== AssetStatus.AVAILABLE) {
          throw new BadRequestException(`Asset ${asset.id} unavailable`);
        }

        if (asset.itemId !== reservation.itemId) {
          throw new BadRequestException(
            `Asset ${asset.id} does not belong to requested item type`,
          );
        }

        const activeAllocationCount = await tx.reservationAllocation.count({
          where: {
            reservationId: allocation.reservationId,
            releasedAt: null,
          },
        });

        if (activeAllocationCount >= reservation.quantity) {
          throw new BadRequestException('Reservation already fully allocated');
        }

        const overlappingAllocation = await tx.reservationAllocation.findFirst({
          where: {
            assetId: allocation.assetId,
            releasedAt: null,
            reservation: {
              startDate: { lte: reservation.endDate },
              endDate: { gte: reservation.startDate },
            },
          },
        });

        if (overlappingAllocation) {
          throw new BadRequestException(`Asset ${asset.id} already allocated`);
        }

        const overlappingMaintenance = await tx.maintenanceRecord.findFirst({
          where: {
            assetId: allocation.assetId,
            startDate: { lte: reservation.endDate },
            endDate: { gte: reservation.startDate },
          },
        });

        if (overlappingMaintenance) {
          throw new BadRequestException(`Asset ${asset.id} under maintenance`);
        }

        await tx.reservationAllocation.create({
          data: {
            reservationId: allocation.reservationId,
            assetId: allocation.assetId,
            allocatedBy,
          },
        });

        await tx.reservationAllocationHistory.create({
          data: {
            reservationId: allocation.reservationId,
            assetId: allocation.assetId,
            action: 'ALLOCATED',
            performedBy: allocatedBy,
          },
        });

        const updatedAllocationCount = await tx.reservationAllocation.count({
          where: {
            reservationId: allocation.reservationId,
            releasedAt: null,
          },
        });

        await tx.resourceReservation.update({
          where: { id: reservation.id },
          data: {
            status:
              updatedAllocationCount >= reservation.quantity
                ? ResourceReservationStatus.ALLOCATED
                : ResourceReservationStatus.PARTIALLY_ALLOCATED,
          },
        });
      }

      return { success: true };
    });
  }

  async releaseAllocation(
    allocationId: number,
    releasedBy?: number,
    reason?: string,
  ) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: { id: allocationId },
      include: { reservation: true },
    });

    if (!allocation) {
      throw new NotFoundException('Allocation not found');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.reservationAllocation.update({
        where: { id: allocationId },
        data: { releasedAt: new Date() },
      });

      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: allocation.reservationId,
          assetId: allocation.assetId,
          action: 'RELEASED',
          performedBy: releasedBy,
          notes: reason,
        },
      });

      const activeAllocationCount = await tx.reservationAllocation.count({
        where: {
          reservationId: allocation.reservationId,
          releasedAt: null,
        },
      });

      // Fix #4: always update status — PARTIALLY_ALLOCATED if some remain, APPROVED if none
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

  async reallocate(dto: ReallocateResourceDto, performedBy?: number) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: { id: dto.allocationId },
      include: { reservation: true },
    });

    if (!allocation) {
      throw new NotFoundException('Allocation not found');
    }

    const newAsset = await this.prisma.asset.findUnique({
      where: { id: dto.newAssetId },
    });

    if (!newAsset) {
      throw new NotFoundException('New asset not found');
    }

    if (newAsset.status !== AssetStatus.AVAILABLE) {
      throw new BadRequestException('Asset unavailable');
    }

    if (newAsset.itemId !== allocation.reservation.itemId) {
      throw new BadRequestException('Asset item type mismatch');
    }

    const overlappingAllocation =
      await this.prisma.reservationAllocation.findFirst({
        where: {
          assetId: dto.newAssetId,
          releasedAt: null,
          reservation: {
            startDate: { lte: allocation.reservation.endDate },
            endDate: { gte: allocation.reservation.startDate },
          },
        },
      });

    if (overlappingAllocation) {
      throw new BadRequestException('Asset already allocated');
    }

    const overlappingMaintenance =
      await this.prisma.maintenanceRecord.findFirst({
        where: {
          assetId: dto.newAssetId,
          startDate: { lte: allocation.reservation.endDate },
          endDate: { gte: allocation.reservation.startDate },
        },
      });

    if (overlappingMaintenance) {
      throw new BadRequestException('Asset under maintenance');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.reservationAllocation.update({
        where: { id: allocation.id },
        data: { releasedAt: new Date() },
      });

      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: allocation.reservationId,
          assetId: allocation.assetId,
          action: 'RELEASED',
          performedBy: performedBy,
          notes: dto.reason,
        },
      });

      const newAllocation = await tx.reservationAllocation.create({
        data: {
          reservationId: allocation.reservationId,
          assetId: dto.newAssetId,
          allocatedBy: performedBy,
        },
      });

      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: allocation.reservationId,
          assetId: dto.newAssetId,
          action: 'REALLOCATED',
          performedBy: performedBy,
          notes: dto.reason,
        },
      });

      return newAllocation;
    });
  }

  async getAll(query: any) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);
    const entityId = query.entityId ? Number(query.entityId) : undefined;
    const where = entityId ? { item: { entityId } } : undefined;

    const [data, total] = await Promise.all([
      this.prisma.resourceReservation.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include: {
          item: true,
          allocations: {
            where: { releasedAt: null },
            include: { asset: true },
          },
          allocationHistory: {
            include: { asset: true },
            orderBy: { performedAt: 'asc' },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.resourceReservation.count({ where }),
    ]);

    if (data.length === 0) {
      return { data: [], total, page, limit };
    }

    const itemIds = [...new Set(data.map((r) => r.itemId))];

    // Fix #5: batch into 2 queries instead of N+1
    // Fix #2: use asset count for ASSET type items
    const [assetCounts, activeReservations] = await Promise.all([
      this.prisma.asset.groupBy({
        by: ['itemId'],
        where: {
          itemId: { in: itemIds },
          status: { notIn: [AssetStatus.DAMAGED, AssetStatus.RETIRED] },
        },
        _count: { id: true },
      }),
      this.prisma.resourceReservation.findMany({
        where: {
          itemId: { in: itemIds },
          status: { notIn: INACTIVE_STATUSES },
        },
        select: {
          id: true,
          itemId: true,
          taskId: true,
          quantity: true,
          startDate: true,
          endDate: true,
        },
      }),
    ]);

    const assetCountMap = new Map(
      assetCounts.map((a) => [a.itemId, a._count.id]),
    );

    const enriched = data.map((reservation) => {
      const totalQuantity =
        reservation.item?.type === ItemType.ASSET
          ? (assetCountMap.get(reservation.itemId) ?? 0)
          : (reservation.item?.quantity ?? 0);

      const reserved = activeReservations
        .filter(
          (r) =>
            r.itemId === reservation.itemId &&
            r.taskId !== reservation.taskId &&
            r.startDate <= reservation.endDate &&
            r.endDate >= reservation.startDate,
        )
        .reduce((sum, r) => sum + r.quantity, 0);

      return { ...reservation, freeQuantity: Math.max(0, totalQuantity - reserved) };
    });

    return { data: enriched, total, page, limit };
  }

  async getOne(id: number) {
    return this.prisma.resourceReservation.findUnique({
      where: { id },
      include: {
        item: true,
        allocations: {
          include: { asset: true },
        },
      },
    });
  }

  async updateTaskReservations(taskId: number, dto: CreateReservationDto) {
    // Fetch item units to determine which resources need hourly logic
    const itemIds = dto.resources.map((r) => r.itemId);
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, unit: true },
    });
    const itemUnitMap = new Map(items.map((i) => [i.id, i.unit]));

    // Pre-generate day slots for HOUR items (validates times, throws if invalid)
    const hourlySlots = new Map<number, DaySlot[]>();
    for (const resource of dto.resources) {
      if (itemUnitMap.get(resource.itemId) === ItemUnit.HOUR) {
        hourlySlots.set(
          resource.itemId,
          splitIntoWorkingDaySlots(dto.startDate, dto.endDate),
        );
      }
    }

    const availability = await this.availabilityService.checkAvailability({
      ...dto,
      excludeTaskId: taskId,
    });
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    return this.prisma.$transaction(async (tx) => {
      // Only look at active reservations — cancelled/completed rows are history
      const existingReservations = await tx.resourceReservation.findMany({
        where: { taskId, status: { notIn: INACTIVE_STATUSES } },
      });

      const incomingItemIds = dto.resources.map((x) => x.itemId);

      // Cancel+release every active row for items completely removed from the task
      for (const existing of existingReservations) {
        if (!incomingItemIds.includes(existing.itemId)) {
          const activeAllocations = await tx.reservationAllocation.findMany({
            where: { reservationId: existing.id, releasedAt: null },
          });

          for (const alloc of activeAllocations) {
            await tx.reservationAllocation.update({
              where: { id: alloc.id },
              data: { releasedAt: new Date() },
            });
            await tx.reservationAllocationHistory.create({
              data: {
                reservationId: existing.id,
                assetId: alloc.assetId,
                action: 'RELEASED',
                notes: 'Released due to task update',
              },
            });
          }

          await tx.resourceReservation.update({
            where: { id: existing.id },
            data: { status: ResourceReservationStatus.CANCELLED },
          });
        }
      }

      for (const resource of dto.resources) {
        const slots = hourlySlots.get(resource.itemId);

        if (slots) {
          // HOUR item: diff existing daily rows against the new set of slots
          const existingRows = existingReservations.filter(
            (x) => x.itemId === resource.itemId,
          );
          const existingByDate = new Map(
            existingRows.map((r) => [getYerevanDateKey(r.startDate), r]),
          );
          const newDateKeys = new Set(slots.map((s) => s.yerevanDate));

          // Cancel+release days that fall outside the new date range
          for (const [dateKey, existing] of existingByDate) {
            if (!newDateKeys.has(dateKey)) {
              const activeAllocations = await tx.reservationAllocation.findMany({
                where: { reservationId: existing.id, releasedAt: null },
              });

              for (const alloc of activeAllocations) {
                await tx.reservationAllocation.update({
                  where: { id: alloc.id },
                  data: { releasedAt: new Date() },
                });
                await tx.reservationAllocationHistory.create({
                  data: {
                    reservationId: existing.id,
                    assetId: alloc.assetId,
                    action: 'RELEASED',
                    notes: 'Released due to task update',
                  },
                });
              }

              await tx.resourceReservation.update({
                where: { id: existing.id },
                data: { status: ResourceReservationStatus.CANCELLED },
              });
            }
          }

          // Update kept days, create new days
          for (const slot of slots) {
            const existing = existingByDate.get(slot.yerevanDate);
            const unavailable = availability.unavailableResources.some(
              (r) => r.itemId === resource.itemId && r.date === slot.yerevanDate,
            );

            if (existing) {
              const activeAllocCount = await tx.reservationAllocation.count({
                where: { reservationId: existing.id, releasedAt: null },
              });

              let newStatus: ResourceReservationStatus;
              if (unavailable) {
                newStatus = ResourceReservationStatus.PENDING;
              } else if (activeAllocCount === 0) {
                newStatus = ResourceReservationStatus.APPROVED;
              } else if (activeAllocCount >= resource.quantity) {
                newStatus = ResourceReservationStatus.ALLOCATED;
              } else {
                newStatus = ResourceReservationStatus.PARTIALLY_ALLOCATED;
              }

              await tx.resourceReservation.update({
                where: { id: existing.id },
                data: {
                  quantity: resource.quantity,
                  startDate: slot.startDate,
                  endDate: slot.endDate,
                  status: newStatus,
                },
              });
            } else {
              await tx.resourceReservation.create({
                data: {
                  taskId,
                  itemId: resource.itemId,
                  quantity: resource.quantity,
                  startDate: slot.startDate,
                  endDate: slot.endDate,
                  status: unavailable
                    ? ResourceReservationStatus.PENDING
                    : ResourceReservationStatus.APPROVED,
                },
              });
            }
          }
        } else {
          // Non-HOUR item: single reservation row for the full date range
          const existing = existingReservations.find(
            (x) => x.itemId === resource.itemId,
          );

          const unavailable = availability.unavailableResources?.some(
            (x) => x.itemId === resource.itemId && !x.date,
          );

          if (existing) {
            const activeAllocCount = await tx.reservationAllocation.count({
              where: { reservationId: existing.id, releasedAt: null },
            });

            let newStatus: ResourceReservationStatus;
            if (unavailable) {
              newStatus = ResourceReservationStatus.PENDING;
            } else if (activeAllocCount === 0) {
              newStatus = ResourceReservationStatus.APPROVED;
            } else if (activeAllocCount >= resource.quantity) {
              newStatus = ResourceReservationStatus.ALLOCATED;
            } else {
              newStatus = ResourceReservationStatus.PARTIALLY_ALLOCATED;
            }

            await tx.resourceReservation.update({
              where: { id: existing.id },
              data: { quantity: resource.quantity, startDate, endDate, status: newStatus },
            });
          } else {
            await tx.resourceReservation.create({
              data: {
                taskId,
                itemId: resource.itemId,
                quantity: resource.quantity,
                startDate,
                endDate,
                status: unavailable
                  ? ResourceReservationStatus.PENDING
                  : ResourceReservationStatus.APPROVED,
              },
            });
          }
        }
      }

      return {
        available: availability.unavailableResources.length === 0,
        unavailableResources: availability.unavailableResources,
      };
    });
  }

  async getTaskReservations(taskId: number) {
    const reservations = await this.prisma.resourceReservation.findMany({
      where: { taskId },
      include: { item: true },
      orderBy: { id: 'asc' },
    });

    return reservations.map((reservation) => ({
      itemId: reservation.itemId,
      itemName: reservation.item.name,
      requestedQuantity: reservation.quantity,
      available: reservation.status !== ResourceReservationStatus.PENDING,
      startDate: reservation.startDate,
      endDate: reservation.endDate,
    }));
  }
}
