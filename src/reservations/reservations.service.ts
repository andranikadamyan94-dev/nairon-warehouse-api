import {
  BadRequestException,
  Injectable,
  Logger,
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
  ResourceReservationStatus.REJECTED,
];

const ALLOCATABLE_STATUSES = [
  ResourceReservationStatus.PENDING,
  ResourceReservationStatus.APPROVED,
  ResourceReservationStatus.PARTIALLY_ALLOCATED,
];

const YEREVAN_UTC_OFFSET = 4;

function parseCustomTime(resource: { startTime?: string; endTime?: string }) {
  if (!resource.startTime || !resource.endTime) return undefined;
  const [startHour, startMinute] = resource.startTime.split(':').map(Number);
  const [endHour, endMinute] = resource.endTime.split(':').map(Number);
  return { startHour, startMinute, endHour, endMinute };
}

function formatUTCasYerevan(d: Date): string {
  const h = (d.getUTCHours() + YEREVAN_UTC_OFFSET) % 24;
  const m = d.getUTCMinutes();
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly availabilityService: AvailabilityService,
  ) {}

  // ─── helpers ────────────────────────────────────────────────────────────────

  private async writeStatusHistory(
    tx: any,
    reservationId: number,
    fromStatus: ResourceReservationStatus | null,
    toStatus: ResourceReservationStatus,
    opts: { previousQuantity?: number; newQuantity?: number; performedBy?: number; reason?: string } = {},
  ) {
    await tx.reservationStatusHistory.create({
      data: {
        reservationId,
        fromStatus: fromStatus ?? undefined,
        toStatus,
        previousQuantity: opts.previousQuantity ?? undefined,
        newQuantity: opts.newQuantity ?? undefined,
        performedBy: opts.performedBy ?? undefined,
        reason: opts.reason ?? undefined,
      },
    });
  }

  // ─── create ─────────────────────────────────────────────────────────────────

  async create(dto: CreateReservationDto) {
    this.logger.log(
      `CREATE reservation | taskId=${dto.taskId} entityId=${dto.entityId} resources=${JSON.stringify(dto.resources)}`,
    );

    const itemIds = dto.resources.map((r) => r.itemId);
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, unit: true },
    });
    const itemUnitMap = new Map(items.map((i) => [i.id, i.unit]));

    const startDate = new Date(dto.startDate);
    const endDate = dto.endDate ? new Date(dto.endDate) : null;

    // Hourly slots only make sense for bounded reservations
    const hourlySlots = new Map<number, DaySlot[]>();
    if (endDate) {
      for (const resource of dto.resources) {
        if (itemUnitMap.get(resource.itemId) === ItemUnit.HOUR) {
          hourlySlots.set(
            resource.itemId,
            splitIntoWorkingDaySlots(dto.startDate, dto.endDate, parseCustomTime(resource)),
          );
        }
      }
    }

    const availability = await this.availabilityService.checkAvailability(dto);

    await this.prisma.$transaction(async (tx) => {
      for (const resource of dto.resources) {
        const slots = hourlySlots.get(resource.itemId);

        if (slots) {
          for (const slot of slots) {
            const isUnavailable = availability.unavailableResources.some(
              (r) => r.itemId === resource.itemId && r.date === slot.yerevanDate,
            );
            const status = isUnavailable
              ? ResourceReservationStatus.PENDING
              : ResourceReservationStatus.APPROVED;

            const created = await tx.resourceReservation.create({
              data: {
                itemId: resource.itemId,
                quantity: resource.quantity,
                taskId: dto.taskId ?? null,
                projectId: dto.projectId ?? null,
                projectName: dto.projectName ?? null,
                entityId: dto.entityId ?? null,
                entityName: dto.entityName ?? null,
                startDate: slot.startDate,
                endDate: slot.endDate,
                status,
              },
            });
            await this.writeStatusHistory(tx, created.id, null, status);
          }
        } else {
          // For open-ended reservations, re-check inside the transaction to prevent race conditions
          if (!endDate) {
            const existingOpenEnded = await tx.resourceReservation.count({
              where: {
                itemId: resource.itemId,
                endDate: null,
                status: { notIn: INACTIVE_STATUSES },
              },
            });
            if (existingOpenEnded > 0) {
              throw new BadRequestException(
                `Item ${resource.itemId} already has an active open-ended reservation`,
              );
            }
          }

          const isUnavailable = availability.unavailableResources.some(
            (r) => r.itemId === resource.itemId && !r.date,
          );
          const status = isUnavailable
            ? ResourceReservationStatus.PENDING
            : ResourceReservationStatus.APPROVED;

          const created = await tx.resourceReservation.create({
            data: {
              itemId: resource.itemId,
              quantity: resource.quantity,
              taskId: dto.taskId ?? null,
              projectId: dto.projectId ?? null,
              projectName: dto.projectName ?? null,
              entityId: dto.entityId ?? null,
              entityName: dto.entityName ?? null,
              startDate,
              endDate,
              status,
            },
          });
          await this.writeStatusHistory(tx, created.id, null, status);
        }
      }
    });

    if (availability.unavailableResources.length) {
      this.logger.warn(
        `CREATE reservation taskId=${dto.taskId} | unavailable: ${JSON.stringify(availability.unavailableResources)}`,
      );
    } else {
      this.logger.log(`CREATE reservation taskId=${dto.taskId} | all available`);
    }

    return {
      available: availability.unavailableResources.length === 0,
      unavailableResources: availability.unavailableResources,
    };
  }

  // ─── allocate (assets) ───────────────────────────────────────────────────────

  async allocate(dto: AllocateReservationDto, allocatedBy?: number) {
    return this.prisma.$transaction(async (tx) => {
      for (const allocation of dto.allocations) {
        const reservation = await tx.resourceReservation.findUnique({
          where: { id: allocation.reservationId },
        });

        if (!reservation) throw new NotFoundException('Reservation not found');

        if (!ALLOCATABLE_STATUSES.includes(reservation.status as ResourceReservationStatus)) {
          throw new BadRequestException(
            `Reservation ${reservation.id} has status ${reservation.status} and cannot be allocated`,
          );
        }

        const asset = await tx.asset.findUnique({ where: { id: allocation.assetId } });
        if (!asset) throw new NotFoundException('Asset not found');
        if (asset.status !== AssetStatus.AVAILABLE)
          throw new BadRequestException(`Asset ${asset.id} unavailable`);
        if (asset.itemId !== reservation.itemId)
          throw new BadRequestException(`Asset ${asset.id} does not belong to requested item type`);

        const activeAllocationCount = await tx.reservationAllocation.count({
          where: { reservationId: allocation.reservationId, releasedAt: null },
        });
        if (activeAllocationCount >= reservation.quantity)
          throw new BadRequestException('Reservation already fully allocated');

        const allocationOverlapFilter = reservation.endDate
          ? {
              OR: [
                { reservation: { endDate: null, startDate: { lte: reservation.endDate } } },
                { reservation: { startDate: { lte: reservation.endDate }, endDate: { gte: reservation.startDate } } },
              ],
            }
          : { reservation: { endDate: null } };

        const overlappingAllocation = await tx.reservationAllocation.findFirst({
          where: { assetId: allocation.assetId, releasedAt: null, ...allocationOverlapFilter },
        });
        if (overlappingAllocation)
          throw new BadRequestException(`Asset ${asset.id} already allocated`);

        const maintenanceOverlapFilter = reservation.endDate
          ? { startDate: { lte: reservation.endDate }, endDate: { gte: reservation.startDate } }
          : { startDate: { gte: reservation.startDate } };

        const overlappingMaintenance = await tx.maintenanceRecord.findFirst({
          where: { assetId: allocation.assetId, ...maintenanceOverlapFilter },
        });
        if (overlappingMaintenance)
          throw new BadRequestException(`Asset ${asset.id} under maintenance`);

        await tx.reservationAllocation.create({
          data: { reservationId: allocation.reservationId, assetId: allocation.assetId, allocatedBy },
        });
        await tx.reservationAllocationHistory.create({
          data: { reservationId: allocation.reservationId, assetId: allocation.assetId, action: 'ALLOCATED', performedBy: allocatedBy },
        });

        const updatedCount = await tx.reservationAllocation.count({
          where: { reservationId: allocation.reservationId, releasedAt: null },
        });

        const newStatus =
          updatedCount >= reservation.quantity
            ? ResourceReservationStatus.ALLOCATED
            : ResourceReservationStatus.PARTIALLY_ALLOCATED;

        await tx.resourceReservation.update({
          where: { id: reservation.id },
          data: { status: newStatus },
        });
        await this.writeStatusHistory(tx, reservation.id, reservation.status as ResourceReservationStatus, newStatus, { performedBy: allocatedBy });
      }

      return { success: true };
    });
  }

  // ─── approve consumable ──────────────────────────────────────────────────────

  async approveConsumable(reservationId: number, performedBy?: number) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: reservationId },
      include: { item: true },
    });

    if (!reservation) throw new NotFoundException('Reservation not found');
    if (reservation.item.type !== ItemType.CONSUMABLE) {
      throw new BadRequestException('Only consumable reservations can be approved this way');
    }
    const approvableStatuses = [
      ResourceReservationStatus.PENDING,
      ResourceReservationStatus.APPROVED,
      ResourceReservationStatus.PARTIALLY_ALLOCATED,
    ];
    if (!approvableStatuses.includes(reservation.status as ResourceReservationStatus)) {
      throw new BadRequestException(
        `Reservation ${reservationId} has status ${reservation.status} and cannot be approved`,
      );
    }

    if (reservation.item.quantity < reservation.quantity) {
      throw new BadRequestException(
        `Insufficient stock: ${reservation.item.quantity} available, ${reservation.quantity} requested`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.reservationAllocation.create({
        data: { reservationId, quantity: reservation.quantity },
      });

      await tx.reservationAllocationHistory.create({
        data: { reservationId, action: 'ALLOCATED', performedBy, notes: 'Consumable approved' },
      });

      await tx.item.update({
        where: { id: reservation.item.id },
        data: { quantity: { decrement: reservation.quantity } },
      });

      await tx.inventoryMovement.create({
        data: {
          itemId: reservation.item.id,
          quantity: -reservation.quantity,
          type: 'OUT',
          taskId: reservation.taskId,
          performedBy,
          notes: `Reservation #${reservationId} approved`,
        },
      });

      await tx.resourceReservation.update({
        where: { id: reservationId },
        data: { status: ResourceReservationStatus.ALLOCATED },
      });

      await this.writeStatusHistory(
        tx,
        reservationId,
        reservation.status as ResourceReservationStatus,
        ResourceReservationStatus.ALLOCATED,
        { performedBy },
      );

      return { success: true };
    });
  }

  // ─── cancel ──────────────────────────────────────────────────────────────────

  async cancel(reservationId: number, performedBy?: number, reason?: string) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) throw new NotFoundException('Reservation not found');
    if (INACTIVE_STATUSES.includes(reservation.status as ResourceReservationStatus)) {
      throw new BadRequestException(`Reservation is already ${reservation.status}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const activeAllocations = await tx.reservationAllocation.findMany({
        where: { reservationId, releasedAt: null },
      });

      for (const alloc of activeAllocations) {
        await tx.reservationAllocation.update({
          where: { id: alloc.id },
          data: { releasedAt: new Date() },
        });
        await tx.reservationAllocationHistory.create({
          data: {
            reservationId,
            assetId: alloc.assetId,
            action: 'RELEASED',
            performedBy,
            notes: reason ?? 'Cancelled',
          },
        });
      }

      await tx.resourceReservation.update({
        where: { id: reservationId },
        data: { status: ResourceReservationStatus.CANCELLED },
      });
      await this.writeStatusHistory(
        tx,
        reservationId,
        reservation.status as ResourceReservationStatus,
        ResourceReservationStatus.CANCELLED,
        { performedBy, reason },
      );

      return { success: true };
    });
  }

  // ─── uncancel ────────────────────────────────────────────────────────────────

  async uncancel(reservationId: number, performedBy?: number) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) throw new NotFoundException('Reservation not found');
    if (reservation.status !== ResourceReservationStatus.CANCELLED) {
      throw new BadRequestException('Only CANCELLED reservations can be reactivated');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.resourceReservation.update({
        where: { id: reservationId },
        data: { status: ResourceReservationStatus.PENDING },
      });
      await this.writeStatusHistory(
        tx,
        reservationId,
        ResourceReservationStatus.CANCELLED,
        ResourceReservationStatus.PENDING,
        { performedBy },
      );
      return { success: true };
    });
  }

  // ─── reject ──────────────────────────────────────────────────────────────────

  async reject(reservationId: number, performedBy?: number, reason?: string) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: reservationId },
    });

    if (!reservation) throw new NotFoundException('Reservation not found');
    if (INACTIVE_STATUSES.includes(reservation.status as ResourceReservationStatus)) {
      throw new BadRequestException(`Reservation is already ${reservation.status}`);
    }

    return this.prisma.$transaction(async (tx) => {
      const activeAllocations = await tx.reservationAllocation.findMany({
        where: { reservationId, releasedAt: null },
      });

      for (const alloc of activeAllocations) {
        await tx.reservationAllocation.update({
          where: { id: alloc.id },
          data: { releasedAt: new Date() },
        });
        await tx.reservationAllocationHistory.create({
          data: {
            reservationId,
            assetId: alloc.assetId,
            action: 'RELEASED',
            performedBy,
            notes: reason ?? 'Rejected',
          },
        });
      }

      await tx.resourceReservation.update({
        where: { id: reservationId },
        data: { status: ResourceReservationStatus.REJECTED },
      });
      await this.writeStatusHistory(
        tx,
        reservationId,
        reservation.status as ResourceReservationStatus,
        ResourceReservationStatus.REJECTED,
        { performedBy, reason },
      );
      return { success: true };
    });
  }

  // ─── release allocation ──────────────────────────────────────────────────────

  async releaseAllocation(allocationId: number, releasedBy?: number, reason?: string) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: { id: allocationId },
      include: { reservation: { include: { item: true } } },
    });

    if (!allocation) throw new NotFoundException('Allocation not found');

    const isConsumable = allocation.reservation.item.type === ItemType.CONSUMABLE;

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

      let newStatus: ResourceReservationStatus;

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
            performedBy: releasedBy,
            notes: reason ?? `Reservation #${allocation.reservationId} allocation cancelled`,
          },
        });
        const restoredQty = (allocation.reservation.item?.quantity ?? 0) + (allocation.quantity ?? 0);
        newStatus = restoredQty >= allocation.reservation.quantity
          ? ResourceReservationStatus.APPROVED
          : ResourceReservationStatus.PENDING;
      } else {
        const activeAllocationCount = await tx.reservationAllocation.count({
          where: { reservationId: allocation.reservationId, releasedAt: null },
        });
        newStatus =
          activeAllocationCount === 0
            ? ResourceReservationStatus.APPROVED
            : ResourceReservationStatus.PARTIALLY_ALLOCATED;
      }

      await tx.resourceReservation.update({
        where: { id: allocation.reservationId },
        data: { status: newStatus },
      });
      await this.writeStatusHistory(
        tx,
        allocation.reservationId,
        allocation.reservation.status as ResourceReservationStatus,
        newStatus,
        { performedBy: releasedBy, reason },
      );

      return { success: true };
    });
  }

  // ─── reallocate ──────────────────────────────────────────────────────────────

  async reallocate(dto: ReallocateResourceDto, performedBy?: number) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: { id: dto.allocationId },
      include: { reservation: true },
    });

    if (!allocation) throw new NotFoundException('Allocation not found');

    const newAsset = await this.prisma.asset.findUnique({ where: { id: dto.newAssetId } });
    if (!newAsset) throw new NotFoundException('New asset not found');
    if (newAsset.status !== AssetStatus.AVAILABLE) throw new BadRequestException('Asset unavailable');
    if (newAsset.itemId !== allocation.reservation.itemId)
      throw new BadRequestException('Asset item type mismatch');

    const resEndDate = allocation.reservation.endDate;
    const resStartDate = allocation.reservation.startDate;

    const reallocOverlapFilter = resEndDate
      ? {
          OR: [
            { reservation: { endDate: null, startDate: { lte: resEndDate } } },
            { reservation: { startDate: { lte: resEndDate }, endDate: { gte: resStartDate } } },
          ],
        }
      : { reservation: { endDate: null } };

    const overlappingAllocation = await this.prisma.reservationAllocation.findFirst({
      where: { assetId: dto.newAssetId, releasedAt: null, ...reallocOverlapFilter },
    });
    if (overlappingAllocation) throw new BadRequestException('Asset already allocated');

    const reallocMaintenanceFilter = resEndDate
      ? { startDate: { lte: resEndDate }, endDate: { gte: resStartDate } }
      : { startDate: { gte: resStartDate } };

    const overlappingMaintenance = await this.prisma.maintenanceRecord.findFirst({
      where: { assetId: dto.newAssetId, ...reallocMaintenanceFilter },
    });
    if (overlappingMaintenance) throw new BadRequestException('Asset under maintenance');

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
          performedBy,
          notes: dto.reason,
        },
      });

      const newAllocation = await tx.reservationAllocation.create({
        data: { reservationId: allocation.reservationId, assetId: dto.newAssetId, allocatedBy: performedBy },
      });
      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: allocation.reservationId,
          assetId: dto.newAssetId,
          action: 'REALLOCATED',
          performedBy,
          notes: dto.reason,
        },
      });

      return newAllocation;
    });
  }

  // ─── getAll ──────────────────────────────────────────────────────────────────

  async getAll(query: any) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);

    const where = {
      status: { not: ResourceReservationStatus.COMPLETED },
    };

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
          statusHistory: {
            orderBy: { performedAt: 'asc' },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { taskId: 'asc' }],
      }),
      this.prisma.resourceReservation.count({ where }),
    ]);

    if (data.length === 0) return { data: [], total, page, limit };

    const itemIds = [...new Set(data.map((r) => r.itemId))];

    const [assetCounts, activeReservations, maintenanceRecords] = await Promise.all([
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
        select: { id: true, itemId: true, taskId: true, quantity: true, startDate: true, endDate: true, status: true },
      }),
      this.prisma.maintenanceRecord.findMany({
        where: { asset: { itemId: { in: itemIds } } },
        select: { assetId: true, startDate: true, endDate: true, asset: { select: { itemId: true } } },
      }),
    ]);

    const assetCountMap = new Map(assetCounts.map((a) => [a.itemId, a._count.id]));

    const FAR_FUTURE = new Date(8640000000000000);

    const enriched = data.map((reservation) => {
      const resEnd = reservation.endDate ?? FAR_FUTURE;
      const overlapping = (r: { itemId: number; startDate: Date; endDate: Date | null }) =>
        r.itemId === reservation.itemId &&
        r.startDate < resEnd &&
        (r.endDate === null || r.endDate > reservation.startDate);

      const assetsUnderMaintenance =
        reservation.item?.type === ItemType.ASSET
          ? new Set(
              maintenanceRecords
                .filter(
                  (m) =>
                    m.asset?.itemId === reservation.itemId &&
                    m.startDate < resEnd &&
                    m.endDate > reservation.startDate,
                )
                .map((m) => m.assetId),
            ).size
          : 0;

      const totalQuantity =
        reservation.item?.type === ItemType.ASSET
          ? Math.max(0, (assetCountMap.get(reservation.itemId) ?? 0) - assetsUnderMaintenance)
          : (reservation.item?.quantity ?? 0);

      // For consumables, ALLOCATED reservations already had their quantity deducted
      // from item.quantity, so counting them again in reservedByOthers would double-subtract.
      const reservedByOthers = activeReservations
        .filter((r) => {
          if (r.taskId === reservation.taskId || !overlapping(r)) return false;
          if (reservation.item?.type === ItemType.CONSUMABLE) {
            return (r as any).status !== ResourceReservationStatus.ALLOCATED;
          }
          return true;
        })
        .reduce((sum, r) => sum + r.quantity, 0);

      const reservedAll = activeReservations
        .filter(overlapping)
        .reduce((sum, r) => sum + r.quantity, 0);

      return {
        ...reservation,
        freeQuantity: Math.max(0, totalQuantity - reservedByOthers),
        globalFreeQuantity: Math.max(0, totalQuantity - reservedAll),
      };
    });

    return { data: enriched, total, page, limit };
  }

  // ─── getOne ──────────────────────────────────────────────────────────────────

  async getOne(id: number) {
    return this.prisma.resourceReservation.findUnique({
      where: { id },
      include: {
        item: true,
        allocations: { include: { asset: true } },
        statusHistory: { orderBy: { performedAt: 'asc' } },
        allocationHistory: { include: { asset: true }, orderBy: { performedAt: 'asc' } },
      },
    });
  }

  // ─── getTaskReservations ─────────────────────────────────────────────────────

  async getTaskReservations(taskId: number) {
    const reservations = await this.prisma.resourceReservation.findMany({
      where: {
        taskId,
        status: { notIn: [ResourceReservationStatus.CANCELLED, ResourceReservationStatus.COMPLETED] },
        replacedByReservationId: null,
      },
      include: {
        item: true,
        allocations: { where: { releasedAt: null } },
        statusHistory: { orderBy: { performedAt: 'asc' } },
      },
      orderBy: { id: 'asc' },
    });

    // Group by itemId — HOUR items have one DB row per working day
    const byItem = new Map<number, typeof reservations>();
    for (const r of reservations) {
      if (!byItem.has(r.itemId)) byItem.set(r.itemId, []);
      byItem.get(r.itemId)!.push(r);
    }

    const groups = Array.from(byItem.values());
    if (groups.length === 0) return [];

    // Real-time availability check (excludes this task's own reservations)
    const allDates = groups.flatMap((g) => g.map((r) => r.startDate));
    const allEndDates = groups.flatMap((g) => g.map((r) => r.endDate)).filter((d): d is Date => d !== null);
    const overallStart = getYerevanDateKey(allDates.reduce((min, d) => (d < min ? d : min)));
    const overallEnd = allEndDates.length > 0
      ? getYerevanDateKey(allEndDates.reduce((max, d) => (d > max ? d : max)))
      : undefined;

    const availabilityResult = await this.availabilityService.checkAvailability({
      startDate: overallStart,
      endDate: overallEnd,
      resources: groups.map((group) => {
        const first = group[0];
        const isHourly = first.item.unit === ItemUnit.HOUR;
        return {
          itemId: first.itemId,
          quantity: first.quantity,
          startTime: isHourly ? formatUTCasYerevan(first.startDate) : undefined,
          endTime: isHourly && first.endDate ? formatUTCasYerevan(first.endDate) : undefined,
        };
      }),
      excludeTaskId: taskId,
    });

    const unavailableItemIds = new Set(availabilityResult.unavailableResources.map((r) => r.itemId));

    const items = groups.flatMap((group) => {
      const first = group[0];
      const isHourly = first.item.unit === ItemUnit.HOUR;

      if (isHourly) {
        // Return one entry per day slot so the CRM can show per-date status
        return group.map((r) => ({
          itemId: r.itemId,
          itemName: r.item.name,
          unit: r.item.unit ?? undefined,
          requestedQuantity: r.quantity,
          allocatedQuantity: r.allocations.reduce((s, a) => s + (a.quantity ?? 1), 0),
          status: r.status,
          startTime: formatUTCasYerevan(r.startDate),
          endTime: formatUTCasYerevan(r.endDate),
          available: !unavailableItemIds.has(r.itemId),
          startDate: r.startDate,
          endDate: r.endDate,
        }));
      }

      const startDate = group.reduce((min, r) => r.startDate < min ? r.startDate : min, first.startDate);
      const endDate = group.reduce((max, r) => r.endDate > max ? r.endDate : max, first.endDate);
      const allocatedQuantity = group.reduce(
        (sum, r) => sum + r.allocations.reduce((s, a) => s + (a.quantity ?? 1), 0),
        0,
      );
      return [{
        reservationId: first.id,
        itemId: first.itemId,
        itemName: first.item.name,
        itemType: first.item.type,
        unit: first.item.unit ?? undefined,
        requestedQuantity: first.quantity,
        allocatedQuantity,
        status: first.status,
        startTime: undefined,
        endTime: undefined,
        available: !unavailableItemIds.has(first.itemId),
        startDate,
        endDate,
      }];
    });

    // Aggregate status history across all reservations, sorted by time
    const history = reservations
      .flatMap((r) =>
        (r.statusHistory ?? []).map((h) => ({
          reservationId: r.id,
          itemName: r.item.name,
          fromStatus: h.fromStatus ?? undefined,
          toStatus: h.toStatus,
          performedAt: h.performedAt,
          reason: h.reason ?? undefined,
          previousQuantity: h.previousQuantity ?? undefined,
          newQuantity: h.newQuantity ?? undefined,
        })),
      )
      .sort((a, b) => new Date(a.performedAt).getTime() - new Date(b.performedAt).getTime());

    return { items, history };
  }

  // ─── updateTaskReservations ──────────────────────────────────────────────────

  async updateTaskReservations(taskId: number, dto: CreateReservationDto) {
    this.logger.log(
      `UPDATE reservation | taskId=${taskId} entityId=${dto.entityId} resources=${JSON.stringify(dto.resources)}`,
    );

    const itemIds = dto.resources.map((r) => r.itemId);
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, unit: true },
    });
    const itemUnitMap = new Map(items.map((i) => [i.id, i.unit]));

    const hourlySlots = new Map<number, DaySlot[]>();
    for (const resource of dto.resources) {
      if (itemUnitMap.get(resource.itemId) === ItemUnit.HOUR) {
        hourlySlots.set(resource.itemId, splitIntoWorkingDaySlots(dto.startDate, dto.endDate, parseCustomTime(resource)));
      }
    }

    const availability = await this.availabilityService.checkAvailability({
      ...dto,
      excludeTaskId: taskId,
    });
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    return this.prisma.$transaction(async (tx) => {
      const existingReservations = await tx.resourceReservation.findMany({
        where: { taskId: taskId, status: { notIn: INACTIVE_STATUSES } },
      });

      const incomingItemIds = dto.resources.map((x) => x.itemId);

      // Cancel rows for items completely removed from the task
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
          await this.writeStatusHistory(
            tx,
            existing.id,
            existing.status as ResourceReservationStatus,
            ResourceReservationStatus.CANCELLED,
            { reason: 'Resource removed from task' },
          );
        }
      }

      for (const resource of dto.resources) {
        const slots = hourlySlots.get(resource.itemId);

        if (slots) {
          const existingRows = existingReservations.filter((x) => x.itemId === resource.itemId);
          const existingByDate = new Map(existingRows.map((r) => [getYerevanDateKey(r.startDate), r] as [string, typeof r]));
          const newDateKeys = new Set(slots.map((s) => s.yerevanDate));

          // Cancel days no longer in range
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
              await this.writeStatusHistory(
                tx,
                existing.id,
                existing.status as ResourceReservationStatus,
                ResourceReservationStatus.CANCELLED,
                { reason: 'Date removed from task' },
              );
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
              if (unavailable) newStatus = ResourceReservationStatus.PENDING;
              else if (activeAllocCount === 0) newStatus = ResourceReservationStatus.APPROVED;
              else if (activeAllocCount >= resource.quantity) newStatus = ResourceReservationStatus.ALLOCATED;
              else newStatus = ResourceReservationStatus.PARTIALLY_ALLOCATED;

              const quantityChanged = existing.quantity !== resource.quantity;
              const statusChanged = existing.status !== newStatus;

              await tx.resourceReservation.update({
                where: { id: existing.id },
                data: {
                  quantity: resource.quantity,
                  startDate: slot.startDate,
                  endDate: slot.endDate,
                  projectId: dto.projectId ?? existing.projectId,
                  projectName: dto.projectName ?? existing.projectName,
                  entityId: dto.entityId ?? existing.entityId,
                  entityName: dto.entityName ?? existing.entityName,
                  status: newStatus,
                },
              });

              if (statusChanged || quantityChanged) {
                await this.writeStatusHistory(
                  tx,
                  existing.id,
                  existing.status as ResourceReservationStatus,
                  newStatus,
                  {
                    previousQuantity: quantityChanged ? existing.quantity : undefined,
                    newQuantity: quantityChanged ? resource.quantity : undefined,
                    reason: 'Task updated',
                  },
                );
              }
            } else {
              const status = unavailable
                ? ResourceReservationStatus.PENDING
                : ResourceReservationStatus.APPROVED;
              const created = await tx.resourceReservation.create({
                data: {
                  taskId: taskId,
                  projectId: dto.projectId ?? null,
                  projectName: dto.projectName ?? null,
                  itemId: resource.itemId,
                  quantity: resource.quantity,
                  entityId: dto.entityId ?? null,
                  entityName: dto.entityName ?? null,
                  startDate: slot.startDate,
                  endDate: slot.endDate,
                  status,
                },
              });
              await this.writeStatusHistory(tx, created.id, null, status, { reason: 'Task updated' });
            }
          }
        } else {
          const existing = existingReservations.find((x) => x.itemId === resource.itemId);
          const unavailable = availability.unavailableResources?.some(
            (x) => x.itemId === resource.itemId && !x.date,
          );

          if (existing) {
            const activeAllocCount = await tx.reservationAllocation.count({
              where: { reservationId: existing.id, releasedAt: null },
            });

            let newStatus: ResourceReservationStatus;
            if (unavailable) newStatus = ResourceReservationStatus.PENDING;
            else if (activeAllocCount === 0) newStatus = ResourceReservationStatus.APPROVED;
            else if (activeAllocCount >= resource.quantity) newStatus = ResourceReservationStatus.ALLOCATED;
            else newStatus = ResourceReservationStatus.PARTIALLY_ALLOCATED;

            const quantityChanged = existing.quantity !== resource.quantity;
            const statusChanged = existing.status !== newStatus;

            await tx.resourceReservation.update({
              where: { id: existing.id },
              data: {
                quantity: resource.quantity,
                startDate,
                endDate,
                entityId: dto.entityId ?? existing.entityId,
                entityName: dto.entityName ?? existing.entityName,
                status: newStatus,
              },
            });

            if (statusChanged || quantityChanged) {
              await this.writeStatusHistory(
                tx,
                existing.id,
                existing.status as ResourceReservationStatus,
                newStatus,
                {
                  previousQuantity: quantityChanged ? existing.quantity : undefined,
                  newQuantity: quantityChanged ? resource.quantity : undefined,
                  reason: 'Task updated',
                },
              );
            }
          } else {
            const status = unavailable
              ? ResourceReservationStatus.PENDING
              : ResourceReservationStatus.APPROVED;
            const created = await tx.resourceReservation.create({
              data: {
                taskId: taskId,
                projectId: dto.projectId ?? null,
                projectName: dto.projectName ?? null,
                itemId: resource.itemId,
                quantity: resource.quantity,
                entityId: dto.entityId ?? null,
                entityName: dto.entityName ?? null,
                startDate,
                endDate,
                status,
              },
            });
            await this.writeStatusHistory(tx, created.id, null, status, { reason: 'Task updated' });
          }
        }
      }

      // Find newly created reservations that replaced cancelled ones and link them
      const cancelledForItems = existingReservations
        .filter((e) => !incomingItemIds.includes(e.itemId))
        .map((e) => e.itemId);

      if (cancelledForItems.length > 0) {
        const newReservations = await tx.resourceReservation.findMany({
          where: {
            taskId,
            itemId: { in: incomingItemIds.filter((id) => cancelledForItems.includes(id)) },
            status: { notIn: INACTIVE_STATUSES },
            createdAt: { gte: new Date(Date.now() - 5000) },
          },
        });

        for (const cancelled of existingReservations.filter(
          (e) => !incomingItemIds.includes(e.itemId),
        )) {
          const replacement = newReservations.find((n) => n.itemId === cancelled.itemId);
          if (replacement) {
            await tx.resourceReservation.update({
              where: { id: cancelled.id },
              data: { replacedByReservationId: replacement.id },
            });
          }
        }
      }

      const result = {
        available: availability.unavailableResources.length === 0,
        unavailableResources: availability.unavailableResources,
      };

      if (availability.unavailableResources.length) {
        this.logger.warn(
          `UPDATE reservation taskId=${taskId} | unavailable: ${JSON.stringify(availability.unavailableResources)}`,
        );
      } else {
        this.logger.log(`UPDATE reservation taskId=${taskId} | completed`);
      }

      return result;
    }, { timeout: 30000 });
  }
}
