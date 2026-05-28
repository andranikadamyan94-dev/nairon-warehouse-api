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
        if (overlappingAllocation)
          throw new BadRequestException(`Asset ${asset.id} already allocated`);

        const overlappingMaintenance = await tx.maintenanceRecord.findFirst({
          where: {
            assetId: allocation.assetId,
            startDate: { lte: reservation.endDate },
            endDate: { gte: reservation.startDate },
          },
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
        newStatus = ResourceReservationStatus.PENDING;
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

    const overlappingAllocation = await this.prisma.reservationAllocation.findFirst({
      where: {
        assetId: dto.newAssetId,
        releasedAt: null,
        reservation: {
          startDate: { lte: allocation.reservation.endDate },
          endDate: { gte: allocation.reservation.startDate },
        },
      },
    });
    if (overlappingAllocation) throw new BadRequestException('Asset already allocated');

    const overlappingMaintenance = await this.prisma.maintenanceRecord.findFirst({
      where: {
        assetId: dto.newAssetId,
        startDate: { lte: allocation.reservation.endDate },
        endDate: { gte: allocation.reservation.startDate },
      },
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
      status: { notIn: [ResourceReservationStatus.CANCELLED, ResourceReservationStatus.COMPLETED] },
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
        },
        orderBy: { taskId: 'asc' },
      }),
      this.prisma.resourceReservation.count({ where }),
    ]);

    if (data.length === 0) return { data: [], total, page, limit };

    const itemIds = [...new Set(data.map((r) => r.itemId))];

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
        select: { id: true, itemId: true, taskId: true, quantity: true, startDate: true, endDate: true },
      }),
    ]);

    const assetCountMap = new Map(assetCounts.map((a) => [a.itemId, a._count.id]));

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
      },
      orderBy: { id: 'asc' },
    });

    return reservations.map((reservation) => {
      const allocatedQuantity = reservation.allocations.reduce(
        (sum, a) => sum + (a.quantity ?? 1),
        0,
      );
      return {
        itemId: reservation.itemId,
        itemName: reservation.item.name,
        requestedQuantity: reservation.quantity,
        allocatedQuantity,
        status: reservation.status,
        available: reservation.status !== ResourceReservationStatus.PENDING,
        startDate: reservation.startDate,
        endDate: reservation.endDate,
      };
    });
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
        hourlySlots.set(resource.itemId, splitIntoWorkingDaySlots(dto.startDate, dto.endDate));
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
          const existingByDate = new Map(existingRows.map((r) => [getYerevanDateKey(r.startDate), r]));
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
    });
  }
}
