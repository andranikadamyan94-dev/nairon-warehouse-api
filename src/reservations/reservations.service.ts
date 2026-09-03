import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { AvailabilityService } from '../availability/availability.service';

import { StockAlertService } from '../common/notifications/stock-alert.service';
import { UsersPrismaService } from '../common/users-prisma.service';
import { WarehouseNotificationsService } from '../common/notifications/notifications.service';

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
    private readonly stockAlerts: StockAlertService,
    private readonly notifications: WarehouseNotificationsService,
    private readonly usersPrisma: UsersPrismaService,
  ) {}

  /**
   * Full event history for a task, independent of the `items` list.
   *
   * `items` deliberately shows only live reservations; history must not. A
   * cancelled or replaced reservation is exactly where the interesting events
   * are ("who removed the excavator, and when"), and the old query filtered
   * those rows out — taking their history with them.
   *
   * Merges three sources: status transitions, asset-level allocation events,
   * and returns.
   */
  private async buildTaskHistory(taskId: number) {
    const reservations = await this.prisma.resourceReservation.findMany({
      where: { taskId },              // no status / replacedBy filter — that is the point
      include: {
        item: { select: { name: true, unit: true } },
        statusHistory: true,
        allocationHistory: { include: { asset: { select: { name: true, serialNumber: true } } } },
        returns: true,
      },
    });
    if (!reservations.length) return [];

    type Entry = {
      kind: 'STATUS' | 'ALLOCATION' | 'RETURN';
      reservationId: number;
      itemName: string;
      performedAt: Date;
      performedById?: number | null;
      performedByName?: string;
      reason?: string;
      fromStatus?: string;
      toStatus?: string;
      previousQuantity?: number;
      newQuantity?: number;
      action?: string;
      assetLabel?: string;
      quantity?: number;
      returnStatus?: string;
      /** Day-slots this entry covers once grouped (HOUR items only). */
      dates?: string[];
      groupedCount?: number;
    };

    const entries: Entry[] = [];

    for (const r of reservations) {
      for (const h of r.statusHistory) {
        entries.push({
          kind: 'STATUS',
          reservationId: r.id,
          itemName: r.item.name,
          performedAt: h.performedAt,
          performedById: h.performedBy,
          reason: h.reason ?? undefined,
          fromStatus: h.fromStatus ?? undefined,
          toStatus: h.toStatus,
          previousQuantity: h.previousQuantity ?? undefined,
          newQuantity: h.newQuantity ?? undefined,
          dates: [getYerevanDateKey(r.startDate)],
        });
      }
      for (const a of r.allocationHistory) {
        entries.push({
          kind: 'ALLOCATION',
          reservationId: r.id,
          itemName: r.item.name,
          performedAt: a.performedAt,
          performedById: a.performedBy,
          reason: a.notes ?? undefined,
          action: a.action,
          assetLabel: a.asset
            ? [a.asset.name, a.asset.serialNumber].filter(Boolean).join(' · ') || undefined
            : undefined,
        });
      }
      for (const ret of r.returns) {
        entries.push({
          kind: 'RETURN',
          reservationId: r.id,
          itemName: r.item.name,
          performedAt: ret.receivedAt ?? ret.requestedAt,
          performedById: ret.receivedBy ?? ret.requestedBy,
          reason: ret.notes ?? undefined,
          quantity: ret.quantity,
          returnStatus: ret.status,
        });
      }
    }

    const grouped = this.groupHourlyStatusEntries(entries);

    // Resolve actor names in one query rather than per entry.
    const ids = [...new Set(grouped.map((e) => e.performedById).filter((v): v is number => !!v))];
    const users = ids.length ? await this.usersPrisma.getUsersByIds(ids) : [];
    const nameById = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

    return grouped
      .map(({ performedById, ...e }) => ({
        ...e,
        performedByName: performedById ? nameById.get(performedById) : undefined,
      }))
      .sort((a, b) => new Date(a.performedAt).getTime() - new Date(b.performedAt).getTime());
  }

  /**
   * HOUR-unit items are stored as one reservation row per working day, so a
   * single edit fans out into one identical status entry per day. Collapse
   * entries that represent the SAME action — same item, same transition, same
   * reason, within a few seconds of each other — into one, carrying the days
   * it covered.
   *
   * Keyed on the action rather than on the item, so days that genuinely
   * diverged (one rejected, the rest approved) do not share a key and stay
   * visible as separate entries. For non-HOUR items there is one row per item,
   * so this never fires.
   *
   * The time bucket is a heuristic: there is no correlation id tying the rows
   * written by one call together. Two distinct actions on the same item with
   * the same transition and reason inside the window would merge — implausible,
   * and harmless if it happened. A `batchId` column would make it exact.
   */
  private groupHourlyStatusEntries<T extends {
    kind: string; itemName: string; fromStatus?: string; toStatus?: string;
    reason?: string; performedAt: Date; dates?: string[]; groupedCount?: number;
  }>(entries: T[]): T[] {
    const BUCKET_MS = 5000;
    const out: T[] = [];
    const byKey = new Map<string, T>();

    for (const e of entries) {
      if (e.kind !== 'STATUS') { out.push(e); continue; }
      const bucket = Math.floor(new Date(e.performedAt).getTime() / BUCKET_MS);
      const key = [e.itemName, e.fromStatus ?? '', e.toStatus ?? '', e.reason ?? '', bucket].join('|');
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...e, groupedCount: 1 });
        continue;
      }
      existing.groupedCount = (existing.groupedCount ?? 1) + 1;
      existing.dates = [...new Set([...(existing.dates ?? []), ...(e.dates ?? [])])].sort();
      // Keep the earliest timestamp of the group.
      if (new Date(e.performedAt) < new Date(existing.performedAt)) existing.performedAt = e.performedAt;
    }

    return [...out, ...byKey.values()];
  }

  // ─── helpers ────────────────────────────────────────────────────────────────

  /**
   * Who to tell about a reservation's outcome. A reservation records no
   * requester (ResourceReservation has no createdBy), so the audience is the
   * assignees of the CRM task it was raised against. Reservations with no
   * taskId have nobody to notify.
   */
  private async taskAssignees(taskId: number | null | undefined): Promise<number[]> {
    if (!taskId) return [];
    const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
    try {
      const res = await fetch(`${crmUrl}/api/project-tasks/${taskId}/internal`, {
        headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
      });
      if (!res.ok) {
        this.logger.warn(`CRM task lookup failed for task ${taskId}: ${res.status}`);
        return [];
      }
      // The internal endpoint resolves assignees to USER objects — `id` is the
      // user id. (The CRM table column is `userId`; don't reach for that here,
      // it isn't in the response and would silently yield zero recipients.)
      const task = (await res.json()) as { assignees?: { id?: number; userId?: number }[] };
      return (task?.assignees ?? [])
        .map((a) => a.id ?? a.userId)
        .filter((id): id is number => Number.isFinite(id));
    } catch (e: any) {
      this.logger.warn(`CRM task lookup error for task ${taskId}: ${e?.message}`);
      return [];
    }
  }

  /** Tell the requesting task's assignees what happened to their reservation. */
  private async notifyRequesters(
    reservation: { taskId?: number | null; projectName?: string | null },
    title: string,
    body: string,
    details: { label: string; value: string }[] = [],
  ): Promise<void> {
    const userIds = await this.taskAssignees(reservation.taskId);
    if (!userIds.length) return;
    await this.notifications.sendToUsers(userIds, {
      title,
      body,
      path: '/reservations',
      details: [
        ...details,
        ...(reservation.projectName ? [{ label: 'Նախագիծ', value: reservation.projectName }] : []),
      ],
    });
  }

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

  /**
   * #1989 task→backlog→warehouse resolution. Task requests are BLOCKED when
   * the task's backlog («նախագիծ») isn't linked to any warehouse — the user's
   * explicit call: every backlog gets linked to main or a sub before people
   * request. Main link → null (all legacy code paths untouched); sub link →
   * that warehouse's id, and its stock drives every flow downstream.
   * Non-task reservations stay on the main pool.
   */
  private async resolveTaskWarehouse(taskId?: number | null): Promise<number | null> {
    if (!taskId) return null;
    // Binding freeze (2026-09-04): once a task has any non-cancelled
    // reservation, its warehouse is settled — availability, updates and new
    // rows all follow the stamped pool. A backlog re-link only affects tasks
    // starting fresh, and an unlinked backlog (or a CRM outage) can never
    // lock an in-flight task out of managing its existing rows.
    const existing = await this.prisma.resourceReservation.findFirst({
      where: { taskId, status: { notIn: INACTIVE_STATUSES } },
      orderBy: { id: 'desc' },
      select: { warehouseId: true },
    });
    if (existing) return existing.warehouseId ?? null;
    const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
    let task: any;
    try {
      const res = await fetch(`${crmUrl}/api/project-tasks/${taskId}/internal`, {
        headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
      });
      if (!res.ok) throw new Error(`CRM ${res.status}`);
      task = await res.json();
    } catch (e: any) {
      this.logger.warn(`Task warehouse resolution failed for task ${taskId}: ${e?.message}`);
      throw new BadRequestException('Առաջադրանքի տվյալները հասանելի չեն (CRM) — փորձեք կրկին');
    }
    const backlogId =
      task?.backlogId ?? task?.sourceBacklogId ?? task?.backlog?.id ?? task?.sourceBacklog?.id ?? null;
    if (!backlogId) {
      throw new BadRequestException(
        'Առաջադրանքի նախագիծը որոշված չէ — պահեստային հայտն արգելափակված է',
      );
    }
    const link = await this.prisma.warehouseBacklog.findUnique({
      where: { backlogId },
      include: { warehouse: true },
    });
    if (!link) {
      throw new BadRequestException(
        'Նախագիծը կապված չէ որևէ պահեստի հետ — դիմեք պահեստի պատասխանատուին',
      );
    }
    if (link.warehouse.type === 'MAIN') return null;
    if (link.warehouse.status !== 'ACTIVE') {
      throw new BadRequestException('Նախագծի պահեստը ակտիվ չէ');
    }
    return link.warehouseId;
  }

  async create(dto: CreateReservationDto, performedBy?: number) {
    this.logger.log(
      `CREATE reservation | taskId=${dto.taskId} entityId=${dto.entityId} resources=${JSON.stringify(dto.resources)}`,
    );

    const warehouseId = await this.resolveTaskWarehouse(dto.taskId);

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

    const availability = await this.availabilityService.checkAvailability({ ...dto, warehouseId });

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
                warehouseId,
                startDate: slot.startDate,
                endDate: slot.endDate,
                status,
              },
            });
            await this.writeStatusHistory(tx, created.id, null, status, { performedBy });
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
              warehouseId,
              startDate,
              endDate,
              status,
            },
          });
          await this.writeStatusHistory(tx, created.id, null, status, { performedBy });
        }
      }
    });

    if (availability.unavailableResources.length) {
      this.logger.warn(
        `CREATE reservation taskId=${dto.taskId} | unavailable: ${JSON.stringify(availability.unavailableResources)}`,
      );
      // Only conflicting requests land in PENDING and need a human decision —
      // freely available stock is auto-approved and needs no alert.
      const names = [...new Set(availability.unavailableResources.map((r: any) => r.name ?? `#${r.itemId}`))];
      void this.notifications.send({
        permissions: ['receive_reservation_alerts', 'manage_warehouse'],
        title: 'Ամրագրում սպասում է հաստատման',
        body: 'Ամրագրման հայտ է ստացվել ռեսուրսի համար, որը հասանելի չէ նշված ժամկետում և սպասում է ձեր որոշմանը։',
        path: '/reservations',
        details: [
          { label: 'Ռեսուրս(ներ)', value: names.join(', ') },
          ...(dto.projectName ? [{ label: 'Նախագիծ', value: dto.projectName }] : []),
          ...(dto.taskId ? [{ label: 'Առաջադրանք', value: `#${dto.taskId}` }] : []),
        ],
      });
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
    // Only reservations that reached ALLOCATED are worth telling the requester
    // about — a partial allocation isn't yet a usable outcome.
    const fullyAllocated: { taskId: number | null; projectName: string | null; quantity: number }[] = [];

    const result = await this.prisma.$transaction(async (tx) => {
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

        if (newStatus === ResourceReservationStatus.ALLOCATED) {
          fullyAllocated.push({
            taskId: reservation.taskId,
            projectName: reservation.projectName,
            quantity: reservation.quantity,
          });
        }
      }

      return { success: true };
    });

    for (const r of fullyAllocated) {
      void this.notifyRequesters(
        r,
        'Ամրագրումը հաստատվել է',
        'Ձեր առաջադրանքի համար պահանջված ռեսուրսը տրամադրվել է։',
        [{ label: 'Քանակ', value: String(r.quantity) }],
      );
    }

    return result;
  }

  // ─── approve consumable ──────────────────────────────────────────────────────

  async approveConsumable(reservationId: number, performedBy?: number, quantity?: number) {
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

    // Approve only what has not been handed out yet. A reservation knocked
    // back to PENDING (or bumped to a higher quantity) may already carry
    // allocations — approving the full amount again would deduct stock twice
    // for goods that already left the shelf.
    const alreadyAllocated = await this.prisma.reservationAllocation.aggregate({
      where: { reservationId, releasedAt: null },
      _sum: { quantity: true },
    });
    const outstanding = reservation.quantity - (alreadyAllocated._sum.quantity ?? 0);
    if (outstanding <= 0) {
      throw new BadRequestException(
        `Reservation ${reservationId} is already fully allocated`,
      );
    }

    // Deliberate partial issuance (#1880): staff may hand out part of the
    // request now — even with full stock on the shelf — and the remainder
    // stays open. No quantity means the old behavior: everything outstanding.
    const toAllocate = quantity ?? outstanding;
    // Integer only: quantities are Int columns — a fractional value would die
    // in Prisma as a 500 instead of an honest 400.
    if (!Number.isInteger(toAllocate) || toAllocate <= 0) {
      throw new BadRequestException('Տրամադրվող քանակը պետք է լինի դրական ամբողջ թիվ');
    }
    if (toAllocate > outstanding) {
      throw new BadRequestException(
        `Տրամադրվող քանակը (${toAllocate}) գերազանցում է չտրամադրված մնացորդը (${outstanding})`,
      );
    }

    // #1989: sub-warehouse reservations draw from THEIR stock, not the main pool.
    if (reservation.warehouseId) {
      const stock = await this.prisma.warehouseStock.findUnique({
        where: { warehouseId_itemId: { warehouseId: reservation.warehouseId, itemId: reservation.item.id } },
        select: { quantity: true },
      });
      if ((stock?.quantity ?? 0) < toAllocate) {
        throw new BadRequestException(
          `Նախագծային պահեստում բավարար պաշար չկա (${stock?.quantity ?? 0} առկա, ${toAllocate} պահանջվում է)`,
        );
      }
    } else if (reservation.item.quantity < toAllocate) {
      throw new BadRequestException(
        `Insufficient stock: ${reservation.item.quantity} available, ${toAllocate} requested`,
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.reservationAllocation.create({
        data: { reservationId, quantity: toAllocate },
      });

      await tx.reservationAllocationHistory.create({
        data: { reservationId, action: 'ALLOCATED', performedBy, notes: 'Ապրանքը տրված է' },
      });

      if (reservation.warehouseId) {
        // Guarded — concurrent issuance must not drive sub stock negative.
        const dec = await tx.warehouseStock.updateMany({
          where: {
            warehouseId: reservation.warehouseId,
            itemId: reservation.item.id,
            quantity: { gte: toAllocate },
          },
          data: { quantity: { decrement: toAllocate } },
        });
        if (dec.count === 0) {
          throw new BadRequestException('Նախագծային պահեստում բավարար պաշար չկա');
        }
      } else {
        await tx.item.update({
          where: { id: reservation.item.id },
          data: { quantity: { decrement: toAllocate } },
        });
      }

      await tx.inventoryMovement.create({
        data: {
          itemId: reservation.item.id,
          quantity: -toAllocate,
          type: 'OUT',
          taskId: reservation.taskId,
          warehouseId: reservation.warehouseId,
          performedBy,
          notes: `Ամրագրում #${reservationId} — տրված`,
        },
      });

      const newStatus =
        toAllocate < outstanding
          ? ResourceReservationStatus.PARTIALLY_ALLOCATED
          : ResourceReservationStatus.ALLOCATED;
      await tx.resourceReservation.update({
        where: { id: reservationId },
        data: { status: newStatus },
      });

      if (reservation.status !== newStatus) {
        await this.writeStatusHistory(
          tx,
          reservationId,
          reservation.status as ResourceReservationStatus,
          newStatus,
          { performedBy },
        );
      }

      return { success: true };
    });

    // The main breach path: approving a consumable reservation takes stock out.
    this.stockAlerts.check([reservation.item.id]);

    void this.notifyRequesters(
      reservation,
      'Ամրագրումը հաստատվել է',
      toAllocate < outstanding
        ? 'Ձեր առաջադրանքի համար կատարված ամրագրումը մասնակի տրամադրվել է։ Մնացորդը դեռ սպասվում է։'
        : 'Ձեր առաջադրանքի համար կատարված ամրագրումը հաստատվել է և ռեսուրսը տրամադրվել է։',
      [
        { label: 'Ռեսուրս', value: reservation.item.name },
        { label: 'Տրամադրված', value: String(toAllocate) },
        ...(toAllocate < outstanding
          ? [{ label: 'Մնացորդ', value: String(outstanding - toAllocate) }]
          : []),
      ],
    );

    return result;
  }

  // ─── task-side acceptance (#1882/#1883) ─────────────────────────────────────

  /**
   * The task confirms it physically received issued goods. Any of the task's
   * three role slots may confirm (validated against CRM); partial acceptance
   * is allowed with an explanatory comment that stays visible to warehouse
   * staff. Invariant: accepted ≤ issued ≤ requested. Accepting the full
   * requested quantity flips the reservation to COMPLETED — this is that
   * status's only setter.
   */
  async accept(
    reservationId: number,
    userId: number,
    quantity: number,
    comment?: string,
  ) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: reservationId },
      include: { item: true },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    if (INACTIVE_STATUSES.includes(reservation.status as ResourceReservationStatus)) {
      throw new BadRequestException(`Reservation is already ${reservation.status}`);
    }
    if (!reservation.taskId) {
      throw new BadRequestException('Միայն առաջադրանքի ամրագրումները կարող են ընդունվել այս ձևով');
    }
    // Goods only. An asset reservation flipped COMPLETED while the asset is
    // physically out would look FREE to availability — a double-booking trap.
    if (reservation.item.type !== ItemType.CONSUMABLE) {
      throw new BadRequestException('Միայն ապրանքային (ծախսվող) ամրագրումները կարող են ընդունվել');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Ընդունվող քանակը պետք է լինի դրական ամբողջ թիվ');
    }

    const { isSuperAdmin } = await this.usersPrisma.getUserAccessInfo(userId);
    if (!isSuperAdmin) {
      await this.assertTaskRole(reservation.taskId, userId);
    }

    // Optimistic concurrency: two role-holders confirming at once must not
    // silently overwrite each other's acceptance — the write only lands if
    // acceptedQuantity is still what this attempt validated against.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.prisma.resourceReservation.findUnique({
        where: { id: reservationId },
        select: { quantity: true, status: true, acceptedQuantity: true, acceptanceComment: true },
      });
      if (!current) throw new NotFoundException('Reservation not found');

      const issuedAgg = await this.prisma.reservationAllocation.aggregate({
        where: { reservationId, releasedAt: null },
        _sum: { quantity: true },
      });
      const issued = issuedAgg._sum.quantity ?? 0;
      const acceptable = issued - (current.acceptedQuantity ?? 0);
      if (acceptable <= 0) {
        throw new BadRequestException('Ընդունելու ենթակա տրամադրված քանակ չկա');
      }
      if (quantity > acceptable) {
        throw new BadRequestException(
          `Ընդունվող քանակը (${quantity}) գերազանցում է տրամադրված չընդունված մնացորդը (${acceptable})`,
        );
      }
      if (quantity < acceptable && !comment?.trim()) {
        throw new BadRequestException(
          'Մասնակի ընդունման դեպքում պարտադիր է նշել պատճառը',
        );
      }

      const newAccepted = (current.acceptedQuantity ?? 0) + quantity;
      const completes = newAccepted >= current.quantity;
      const stamp = `[${new Date().toISOString().slice(0, 10)}] ${comment?.trim() ?? ''}`.trim();

      const landed = await this.prisma.$transaction(async (tx) => {
        const res = await tx.resourceReservation.updateMany({
          where: { id: reservationId, acceptedQuantity: current.acceptedQuantity ?? 0 },
          data: {
            acceptedQuantity: newAccepted,
            ...(comment?.trim()
              ? {
                  acceptanceComment: current.acceptanceComment
                    ? `${current.acceptanceComment}\n${stamp}`
                    : stamp,
                }
              : {}),
            ...(completes ? { status: ResourceReservationStatus.COMPLETED } : {}),
          },
        });
        if (res.count === 0) return false;
        if (completes) {
          await this.writeStatusHistory(
            tx,
            reservationId,
            current.status as ResourceReservationStatus,
            ResourceReservationStatus.COMPLETED,
            { performedBy: userId, reason: 'Ամբողջ քանակն ընդունվել է առաջադրանքի կողմից' },
          );
        }
        return true;
      });

      if (landed) {
        return this.prisma.resourceReservation.findUnique({ where: { id: reservationId } });
      }
      // someone else's acceptance landed first — re-validate against fresh state
    }
    throw new BadRequestException('Զուգահեռ ընդունում է կատարվել — թարմացրեք էջը և կրկնեք');
  }

  /**
   * Take back the ISSUED-BUT-UNACCEPTED remainder (2026-09-02, closes the
   * dispute dead-end): goods the task refused to confirm come off `issued`,
   * reopening the issuance ceiling so replacements can go out. Damaged goods
   * are scrapped — no stock credit (they left the shelf at issuance and are
   * not coming back to it); usable ones return to stock with an IN movement.
   * Never touches what the task accepted: the cap is issued − accepted.
   */
  async reclaim(
    reservationId: number,
    performedBy: number | undefined,
    quantity: number,
    damaged: boolean,
    reason?: string,
  ) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: reservationId },
      include: { item: true },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');
    if (INACTIVE_STATUSES.includes(reservation.status as ResourceReservationStatus)) {
      throw new BadRequestException(`Reservation is already ${reservation.status}`);
    }
    if (reservation.item.type !== ItemType.CONSUMABLE) {
      throw new BadRequestException('Հետ վերցնելը կիրառելի է միայն ապրանքային ամրագրումների համար');
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new BadRequestException('Քանակը պետք է լինի դրական ամբողջ թիվ');
    }

    return this.prisma.$transaction(async (tx) => {
      const active = await tx.reservationAllocation.findMany({
        where: { reservationId, releasedAt: null },
        orderBy: { id: 'desc' },
      });
      const issued = active.reduce((s, a) => s + (a.quantity ?? 1), 0);
      const accepted = (reservation as any).acceptedQuantity ?? 0;
      const reclaimable = issued - accepted;
      if (quantity > reclaimable) {
        throw new BadRequestException(
          `Հետ վերցվող քանակը (${quantity}) գերազանցում է տրամադրված չընդունված մնացորդը (${reclaimable})`,
        );
      }

      // Reduce newest allocations first; split a row when only part of it is
      // reclaimed, so every released unit is a real, dated row in history.
      let remaining = quantity;
      for (const alloc of active) {
        if (remaining <= 0) break;
        const take = Math.min(alloc.quantity ?? 1, remaining);
        if (take === (alloc.quantity ?? 1)) {
          await tx.reservationAllocation.update({
            where: { id: alloc.id },
            data: { releasedAt: new Date() },
          });
        } else {
          await tx.reservationAllocation.update({
            where: { id: alloc.id },
            data: { quantity: (alloc.quantity ?? 1) - take },
          });
          await tx.reservationAllocation.create({
            data: { reservationId, quantity: take, releasedAt: new Date() },
          });
        }
        remaining -= take;
      }
      await tx.reservationAllocationHistory.create({
        data: {
          reservationId,
          action: 'RELEASED',
          performedBy,
          notes: damaged
            ? `Հետ է վերցվել ${quantity} հատ՝ վնասված (պաշար չի վերադարձվել)${reason ? ` — ${reason}` : ''}`
            : `Հետ է վերցվել ${quantity} հատ՝ պիտանի (վերադարձվել է պաշար)${reason ? ` — ${reason}` : ''}`,
        },
      });

      if (!damaged) {
        if (reservation.warehouseId) {
          await tx.warehouseStock.upsert({
            where: { warehouseId_itemId: { warehouseId: reservation.warehouseId, itemId: reservation.itemId } },
            update: { quantity: { increment: quantity } },
            create: { warehouseId: reservation.warehouseId, itemId: reservation.itemId, quantity },
          });
        } else {
          await tx.item.update({
            where: { id: reservation.itemId },
            data: { quantity: { increment: quantity } },
          });
        }
        await tx.inventoryMovement.create({
          data: {
            itemId: reservation.itemId,
            quantity,
            type: 'IN',
            taskId: reservation.taskId,
            warehouseId: reservation.warehouseId,
            performedBy,
            notes: reason ?? `Ամրագրում #${reservationId} — չընդունված քանակի վերադարձ`,
          },
        });
      }

      // Acceptance-aware status: the reservation goes back to waiting for the
      // replacement issue (or plain APPROVED when nothing is out at all).
      const newIssued = issued - quantity;
      const newStatus =
        newIssued === 0 && accepted === 0
          ? ResourceReservationStatus.APPROVED
          : ResourceReservationStatus.PARTIALLY_ALLOCATED;
      if (reservation.status !== newStatus) {
        await tx.resourceReservation.update({
          where: { id: reservationId },
          data: { status: newStatus },
        });
        await this.writeStatusHistory(
          tx,
          reservationId,
          reservation.status as ResourceReservationStatus,
          newStatus,
          { performedBy, reason: reason ?? 'Չընդունված քանակը հետ է վերցվել' },
        );
      }

      return { reclaimed: quantity, damaged, issuedNow: newIssued };
    });
  }

  /** The acceptor/executor/responsible slots of the task, asked from CRM —
   * the warehouse has no task-role data of its own. */
  private async assertTaskRole(taskId: number, userId: number) {
    const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
    let task: any;
    try {
      const res = await fetch(`${crmUrl}/api/project-tasks/${taskId}/internal`, {
        headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
      });
      if (!res.ok) throw new Error(String(res.status));
      task = await res.json();
    } catch {
      throw new BadRequestException('Առաջադրանքի տվյալները հասանելի չեն — փորձեք կրկին');
    }
    const inRole = ['acceptors', 'executors', 'responsibles'].some((r) =>
      (task?.[r] ?? []).some((u: any) => (u.id ?? u.userId) === userId),
    );
    if (!inRole) {
      throw new ForbiddenException(
        'Ընդունել կարող են միայն առաջադրանքի Կատարողը, Ստուգողը կամ Պատասխանատուն',
      );
    }
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
            notes: reason ?? 'Չեղարկված',
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

    const result = await this.prisma.$transaction(async (tx) => {
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
            notes: reason ?? 'Մերժված',
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

    void this.notifyRequesters(
      reservation,
      'Ամրագրումը մերժվել է',
      'Ձեր առաջադրանքի համար կատարված ամրագրման հայտը մերժվել է։',
      reason ? [{ label: 'Պատճառ', value: reason }] : [],
    );

    return result;
  }

  // ─── release allocation ──────────────────────────────────────────────────────

  async releaseAllocation(allocationId: number, releasedBy?: number, reason?: string) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: { id: allocationId },
      include: { reservation: { include: { item: true } } },
    });

    if (!allocation) throw new NotFoundException('Allocation not found');

    const isConsumable = allocation.reservation.item.type === ItemType.CONSUMABLE;

    // Once acceptance has started, a raw whole-row release is a three-way
    // footgun: it takes back goods the task confirmed KEEPING, credits them
    // to stock, and wrecks the accepted ≤ issued invariant. The reclaim flow
    // handles the unaccepted remainder correctly.
    if (isConsumable && ((allocation.reservation as any).acceptedQuantity ?? 0) > 0) {
      throw new BadRequestException(
        'Ընդունումն արդեն սկսված է — չընդունված մնացորդը հետ վերցրեք «Հետ վերցնել» գործողությամբ',
      );
    }

    const result = await this.prisma.$transaction(async (tx) => {
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
        await tx.inventoryMovement.create({
          data: {
            itemId: allocation.reservation.itemId,
            quantity: allocation.quantity,
            type: 'IN',
            taskId: allocation.reservation.taskId,
            warehouseId: whId,
            performedBy: releasedBy,
            notes: reason ?? `Ամրագրում #${allocation.reservationId} — հատկացումը չեղարկված`,
          },
        });
        const poolQty = whId
          ? (await tx.warehouseStock.findUnique({
              where: { warehouseId_itemId: { warehouseId: whId, itemId: allocation.reservation.itemId } },
              select: { quantity: true },
            }))?.quantity ?? 0
          : (allocation.reservation.item?.quantity ?? 0) + (allocation.quantity ?? 0);
        const restoredQty = poolQty;
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

    if (isConsumable) this.stockAlerts.check([allocation.reservation.itemId]);

    return result;
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

  async getMine(userId: number, query: any) {
    const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
    let taskIds: number[] = [];
    try {
      const res = await fetch(`${crmUrl}/api/project-tasks/internal/assigned/${userId}`, {
        headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
      });
      if (res.ok) {
        const body = (await res.json()) as { taskIds?: number[] };
        taskIds = body?.taskIds ?? [];
      } else {
        this.logger.warn(`CRM assigned-tasks lookup failed for user ${userId}: ${res.status}`);
      }
    } catch (e: any) {
      this.logger.warn(`CRM assigned-tasks lookup error for user ${userId}: ${e?.message}`);
    }

    if (!taskIds.length) {
      return { data: [], total: 0, page: Number(query.page ?? 1), limit: Number(query.limit ?? 10) };
    }
    return this.getAll(query, { taskId: { in: taskIds } });
  }

  async getAll(query: any, extraWhere: any = null) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);

    const where: any = { ...(extraWhere ?? {}) };

    if (query.status) {
      where.status = query.status;
    } else {
      where.status = { not: ResourceReservationStatus.COMPLETED };
    }

    if (query.search) {
      where.OR = [
        { item: { name: { contains: query.search, mode: 'insensitive' } } },
        { entityName: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const order: 'asc' | 'desc' = query.sortOrder === 'asc' ? 'asc' : 'desc';
    // id last, on every branch. status and entityName have very few distinct
    // values, so most rows tie; tied rows with no tiebreaker can come back in a
    // different arrangement per query, and skip/take then repeats some
    // reservations across pages while never showing others.
    const orderBy: any[] =
      query.sortBy === 'startDate' ? [{ startDate: order }, { id: 'desc' }]
      : query.sortBy === 'entityName' ? [{ entityName: order }, { id: 'desc' }]
      : query.sortBy === 'status' ? [{ status: order }, { id: 'desc' }]
      : query.sortBy === 'createdAt' ? [{ createdAt: order }, { id: 'desc' }]
      : [{ createdAt: 'desc' }, { taskId: 'asc' }, { id: 'desc' }];

    const include = {
      item: true,
      warehouse: { select: { id: true, name: true, code: true, type: true } },
      allocations: {
        where: { releasedAt: null },
        include: { asset: true },
      },
      allocationHistory: {
        include: { asset: true },
        orderBy: { performedAt: 'asc' as const },
      },
      statusHistory: {
        orderBy: { performedAt: 'asc' as const },
      },
    };

    let data: any[];
    let total: number;
    if (query.groupByTask === '1') {
      // Group-key pagination (2026-09-03): a page holds N task-groups (a
      // taskless reservation is its own group), and every group arrives with
      // ALL its matching rows — grouping can't be split by a page boundary.
      // Keys keep the requested sort: a group ranks where its best-ranked row
      // ranks.
      const keyRows = await this.prisma.resourceReservation.findMany({
        where,
        select: { id: true, taskId: true },
        orderBy,
      });
      const seen = new Set<string>();
      const keys: { id: number; taskId: number | null }[] = [];
      for (const r of keyRows) {
        const k = r.taskId != null ? `t${r.taskId}` : `r${r.id}`;
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(r);
        }
      }
      total = keys.length;
      const slice = keys.slice((page - 1) * limit, page * limit);
      const taskIds = slice.filter((s) => s.taskId != null).map((s) => s.taskId as number);
      const soloIds = slice.filter((s) => s.taskId == null).map((s) => s.id);
      data = await this.prisma.resourceReservation.findMany({
        where: { AND: [where, { OR: [{ taskId: { in: taskIds } }, { id: { in: soloIds } }] }] },
        include,
        orderBy,
      });
    } else {
      [data, total] = await Promise.all([
        this.prisma.resourceReservation.findMany({
          where,
          skip: (page - 1) * limit,
          take: limit,
          include,
          orderBy,
        }),
        this.prisma.resourceReservation.count({ where }),
      ]);
    }

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
        select: { id: true, itemId: true, taskId: true, quantity: true, startDate: true, endDate: true, status: true, warehouseId: true },
      }),
      this.prisma.maintenanceRecord.findMany({
        where: { asset: { itemId: { in: itemIds } } },
        select: { assetId: true, startDate: true, endDate: true, asset: { select: { itemId: true } } },
      }),
    ]);

    const assetCountMap = new Map<number | null, number>(assetCounts.map((a) => [a.itemId, a._count.id]));

    // #1989: sub-warehouse reservations draw from their own stock rows.
    const whPairs = [...new Set(data.filter((r: any) => r.warehouseId).map((r: any) => `${r.warehouseId}:${r.itemId}`))];
    const subStocks = whPairs.length
      ? await this.prisma.warehouseStock.findMany({
          where: { OR: whPairs.map((p) => ({ warehouseId: Number(p.split(':')[0]), itemId: Number(p.split(':')[1]) })) },
          select: { warehouseId: true, itemId: true, quantity: true },
        })
      : [];
    const subStockMap = new Map(subStocks.map((s) => [`${s.warehouseId}:${s.itemId}`, s.quantity]));

    const FAR_FUTURE = new Date(8640000000000000);

    const enriched = data.map((reservation) => {
      const resEnd = reservation.endDate ?? FAR_FUTURE;
      // Only same-pool reservations compete for the same stock.
      const overlapping = (r: { itemId: number; startDate: Date; endDate: Date | null; warehouseId?: number | null }) =>
        r.itemId === reservation.itemId &&
        (r.warehouseId ?? null) === ((reservation as any).warehouseId ?? null) &&
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
          : (reservation as any).warehouseId
            ? subStockMap.get(`${(reservation as any).warehouseId}:${reservation.itemId}`) ?? 0
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
        // COMPLETED stays visible: a fully accepted reservation must keep its
        // card in the task modal (vanishing on accept read as data loss —
        // 2026-09-01). Only CANCELLED disappears.
        status: { not: ResourceReservationStatus.CANCELLED },
        replacedByReservationId: null,
      },
      include: {
        item: true,
        allocations: { where: { releasedAt: null } },
        statusHistory: { orderBy: { performedAt: 'asc' } },
      },
      orderBy: { id: 'asc' },
    });

    // Group by itemId — HOUR items have one DB row per working day. COMPLETED
    // reservations each stand alone: folding one into an active group for the
    // same item (completed earlier + freshly re-requested) would blend two
    // different lifecycles into one bogus row.
    const byItem = new Map<number | string, typeof reservations>();
    for (const r of reservations) {
      const key = r.status === ResourceReservationStatus.COMPLETED ? `done-${r.id}` : r.itemId;
      if (!byItem.has(key)) byItem.set(key, []);
      byItem.get(key)!.push(r);
    }

    const groups = Array.from(byItem.values());
    // No LIVE reservations still means there may be history worth showing — a
    // task whose resources were all removed is precisely the case where "who
    // removed them, and when" matters. Returning early here hid exactly that.
    if (groups.length === 0) {
      return { items: [], history: await this.buildTaskHistory(taskId) };
    }

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
      // One task = one warehouse: every reservation of the task shares it.
      warehouseId: (reservations[0] as any)?.warehouseId ?? null,
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
      // The acceptance handshake (#1882): what is currently in the task's
      // hands (issued = unreleased allocations) vs what they've confirmed.
      const issuedQuantity = group.reduce(
        (sum, r) => sum + r.allocations.filter((a) => !a.releasedAt).reduce((s, a) => s + (a.quantity ?? 1), 0),
        0,
      );
      const acceptedQuantity = group.reduce((s, r) => s + ((r as any).acceptedQuantity ?? 0), 0);
      return [{
        reservationId: first.id,
        itemId: first.itemId,
        itemName: first.item.name,
        itemType: first.item.type,
        unit: first.item.unit ?? undefined,
        requestedQuantity: first.quantity,
        allocatedQuantity,
        issuedQuantity,
        acceptedQuantity,
        status: first.status,
        startTime: undefined,
        endTime: undefined,
        available: !unavailableItemIds.has(first.itemId),
        startDate,
        endDate,
      }];
    });

    // History is built independently of `items`: it must include cancelled,
    // completed and replaced reservations, which `items` deliberately excludes.
    const history = await this.buildTaskHistory(taskId);

    return { items, history };
  }

  // ─── updateTaskReservations ──────────────────────────────────────────────────

  async updateTaskReservations(taskId: number, dto: CreateReservationDto, performedBy?: number) {
    this.logger.log(
      `UPDATE reservation | taskId=${taskId} entityId=${dto.entityId} resources=${JSON.stringify(dto.resources)}`,
    );

    const warehouseId = await this.resolveTaskWarehouse(taskId);

    const itemIds = dto.resources.map((r) => r.itemId);
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, unit: true, type: true },
    });
    const itemUnitMap = new Map(items.map((i) => [i.id, i.unit]));
    const itemTypeMap = new Map(items.map((i) => [i.id, i.type]));

    const hourlySlots = new Map<number, DaySlot[]>();
    for (const resource of dto.resources) {
      if (itemUnitMap.get(resource.itemId) === ItemUnit.HOUR) {
        hourlySlots.set(resource.itemId, splitIntoWorkingDaySlots(dto.startDate, dto.endDate, parseCustomTime(resource)));
      }
    }

    const availability = await this.availabilityService.checkAvailability({
      ...dto,
      excludeTaskId: taskId,
      warehouseId,
    });

    // excludeTaskId removes this task's reservation ROWS from the math, but a
    // consumable the warehouse already handed to this task has also left
    // Item.quantity. Re-sending that row means "keep what I have", not "give
    // me the same again" — credit the task's own unreleased allocations so
    // delivered items don't flip back to PENDING on every save.
    if (availability.unavailableResources.length) {
      const kept: typeof availability.unavailableResources = [];
      for (const u of availability.unavailableResources) {
        if (u.date || itemTypeMap.get(u.itemId) === ItemType.ASSET) {
          kept.push(u);
          continue;
        }
        const own = await this.prisma.reservationAllocation.aggregate({
          where: {
            releasedAt: null,
            reservation: {
              taskId,
              itemId: u.itemId,
              status: { notIn: INACTIVE_STATUSES },
            },
          },
          _sum: { quantity: true },
        });
        const credit = own._sum.quantity ?? 0;
        if (u.available + credit < u.requested) {
          kept.push({ ...u, available: u.available + credit });
        }
      }
      availability.unavailableResources = kept;
    }
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    return this.prisma.$transaction(async (tx) => {
      const existingReservations = await tx.resourceReservation.findMany({
        where: { taskId: taskId, status: { notIn: [ResourceReservationStatus.CANCELLED, ResourceReservationStatus.COMPLETED] } },
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
                notes: 'Ազատված՝ առաջադրանքի փոփոխության պատճառով',
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
            { reason: 'Ռեսուրսը հեռացվել է առաջադրանքից', performedBy },
          );
        }
      }

      for (const resource of dto.resources) {
        const slots = hourlySlots.get(resource.itemId);

        if (slots) {
          const existingRows = existingReservations.filter((x) => x.itemId === resource.itemId);
          const existingByDate = new Map<string, (typeof existingRows)[0]>(existingRows.map((r) => [getYerevanDateKey(r.startDate), r]));
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
                    notes: 'Ազատված՝ առաջադրանքի փոփոխության պատճառով',
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
                { reason: 'Date removed from task', performedBy },
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
              // Sum of quantities, not row count: an approved consumable is one
              // allocation row carrying the whole amount (assets are 1 per row,
              // so the sum is right for both).
              const activeAllocAgg = await tx.reservationAllocation.aggregate({
                where: { reservationId: existing.id, releasedAt: null },
                _sum: { quantity: true },
              });
              const activeAllocCount = activeAllocAgg._sum.quantity ?? 0;

              // A consumable cannot be reduced below what was handed out —
              // the goods are with the task and stock was already deducted;
              // releasing the allocation without restocking would lose the
              // units. Physical give-backs go through the returns flow.
              const targetQuantity =
                itemTypeMap.get(resource.itemId) !== ItemType.ASSET
                  ? Math.max(resource.quantity, activeAllocCount)
                  : resource.quantity;

              if (activeAllocCount > targetQuantity) {
                const excessAllocs = await tx.reservationAllocation.findMany({
                  where: { reservationId: existing.id, releasedAt: null },
                  orderBy: { id: 'desc' },
                  take: activeAllocCount - targetQuantity,
                });
                for (const alloc of excessAllocs) {
                  await tx.reservationAllocation.update({
                    where: { id: alloc.id },
                    data: { releasedAt: new Date() },
                  });
                  await tx.reservationAllocationHistory.create({
                    data: {
                      reservationId: existing.id,
                      assetId: alloc.assetId,
                      action: 'RELEASED',
                      notes: 'Ազատված՝ քանակի նվազման պատճառով',
                    },
                  });
                }
              }

              const effectiveAllocCount = Math.min(activeAllocCount, targetQuantity);

              let newStatus: ResourceReservationStatus;
              if (unavailable) newStatus = ResourceReservationStatus.PENDING;
              else if (effectiveAllocCount === 0) newStatus = ResourceReservationStatus.APPROVED;
              else if (effectiveAllocCount >= targetQuantity) newStatus = ResourceReservationStatus.ALLOCATED;
              else newStatus = ResourceReservationStatus.PARTIALLY_ALLOCATED;

              const quantityChanged = existing.quantity !== targetQuantity;
              const statusChanged = existing.status !== newStatus;

              await tx.resourceReservation.update({
                where: { id: existing.id },
                data: {
                  quantity: targetQuantity,
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
                    newQuantity: quantityChanged ? targetQuantity : undefined,
                    reason: 'Առաջադրանքը թարմացվել է',
                    performedBy,
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
                  warehouseId,
                  startDate: slot.startDate,
                  endDate: slot.endDate,
                  status,
                },
              });
              await this.writeStatusHistory(tx, created.id, null, status, { reason: 'Առաջադրանքը թարմացվել է', performedBy });
            }
          }
        } else {
          const existing = existingReservations.find((x) => x.itemId === resource.itemId);
          const unavailable = availability.unavailableResources?.some(
            (x) => x.itemId === resource.itemId && !x.date,
          );

          if (existing) {
            // Sum of quantities, not row count — see the hourly branch above.
            const activeAllocAgg = await tx.reservationAllocation.aggregate({
              where: { reservationId: existing.id, releasedAt: null },
              _sum: { quantity: true },
            });
            const activeAllocCount = activeAllocAgg._sum.quantity ?? 0;

            // Same clamp as the hourly branch: delivered consumables can only
            // be reduced through the returns flow, never by editing the request.
            const targetQuantity =
              itemTypeMap.get(resource.itemId) !== ItemType.ASSET
                ? Math.max(resource.quantity, activeAllocCount)
                : resource.quantity;

            // Release excess allocations when quantity decreases
            if (activeAllocCount > targetQuantity) {
              const excessAllocs = await tx.reservationAllocation.findMany({
                where: { reservationId: existing.id, releasedAt: null },
                orderBy: { id: 'desc' },
                take: activeAllocCount - targetQuantity,
              });
              for (const alloc of excessAllocs) {
                await tx.reservationAllocation.update({
                  where: { id: alloc.id },
                  data: { releasedAt: new Date() },
                });
                await tx.reservationAllocationHistory.create({
                  data: {
                    reservationId: existing.id,
                    assetId: alloc.assetId,
                    action: 'RELEASED',
                    notes: 'Ազատված՝ քանակի նվազման պատճառով',
                  },
                });
              }
            }

            const effectiveAllocCount = Math.min(activeAllocCount, targetQuantity);

            let newStatus: ResourceReservationStatus;
            if (unavailable) newStatus = ResourceReservationStatus.PENDING;
            else if (effectiveAllocCount === 0) newStatus = ResourceReservationStatus.APPROVED;
            else if (
              // A request reduced down to what was already accepted has nothing
              // left to issue or confirm — close it, or it sits ALLOCATED forever.
              effectiveAllocCount >= targetQuantity &&
              ((existing as any).acceptedQuantity ?? 0) >= targetQuantity
            )
              newStatus = ResourceReservationStatus.COMPLETED;
            else if (effectiveAllocCount >= targetQuantity) newStatus = ResourceReservationStatus.ALLOCATED;
            else newStatus = ResourceReservationStatus.PARTIALLY_ALLOCATED;

            const quantityChanged = existing.quantity !== targetQuantity;
            const statusChanged = existing.status !== newStatus;

            await tx.resourceReservation.update({
              where: { id: existing.id },
              data: {
                quantity: targetQuantity,
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
                  newQuantity: quantityChanged ? targetQuantity : undefined,
                  reason: 'Առաջադրանքը թարմացվել է',
                  performedBy,
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
                warehouseId,
                startDate,
                endDate,
                status,
              },
            });
            await this.writeStatusHistory(tx, created.id, null, status, { reason: 'Առաջադրանքը թարմացվել է', performedBy });
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
