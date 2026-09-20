import { settleStoredQty } from '../common/stored-quantity';
import { roundQty } from '../common/quantity';
import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';import { PrismaService } from 'prisma/prisma.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';
import { ItemType } from '../common/enums/item-type.enum';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';
import { ReservationsService } from '../reservations/reservations.service';
import { decideOperation, isWarehouseViewer, mayRead } from '../reservations/two-party';
import { quantitiesOf } from '../reservations/quantities';
import { lockReservation } from '../common/operations/row-lock';

/** What filing this return would mean, before it is filed. */
export type ReturnPreview = {
  reservationId: number;
  itemId: number;
  itemName: string;
  unit: string | null;
  reservationStatus: string;
  requesterWorkspaceId: number | null;
  stockOwnerWorkspaceId: number | null;
  /** The catalogue, not the company — see ReservationRequestPreview. */
  catalogueName: string | null;
  /** What was asked for originally. History, never a counter. */
  requested: number;
  /** Everything that has ever left the shelf against this request. */
  issued: number;
  /** What has come back and been received. */
  returned: number;
  /** What is physically out right now. */
  out: number;
  /** What could still be handed back, counting returns already filed. */
  returnable: number;
  returningNow: number;
  /** Always true: CONFIRM measures again inside the transaction that writes. */
  outstandingIsInformational: true;
};

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
    private readonly workspaces: ResourceWorkspaceService,
    private readonly reservations: ReservationsService,
  ) {}

  private readonly include = {
    reservation: {
      include: { item: true },
    },
  };

  /** Unreleased allocation quantity — what the task physically holds. */
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

  private async issuedOf(tx: any, reservationId: number): Promise<number> {
    const agg = await tx.reservationAllocation.aggregate({
      where: { reservationId, releasedAt: null },
      _sum: { quantity: true },
    });
    return agg._sum.quantity ?? 0;
  }

  /** The same, plus what says whose stock it was — for the read rule. */
  private readonly includeWithCatalogue = {
    reservation: {
      include: { item: { include: { category: { select: { id: true, entityId: true, name: true } } } } },
    },
  };

  /**
   * Who may see the whole return list.
   *
   * `GET /resource-returns` carries no permission guard at all, because the CRM
   * task screen reads it and the people on a task hold no warehouse rights. With
   * no filter it answered with every return in the installation, to anybody with
   * a token. Warehouse staff may still have the whole list; everybody else has
   * to name the task they are asking about, which is what the CRM client has
   * always sent anyway.
   */
  private mayListEverything(actor: WarehouseActor): boolean {
    if (actor.isSuperAdmin) return true;
    return ['view_resource_returns', 'manage_resource_returns', 'view_warehouse', 'manage_warehouse'].some(
      (p) => actor.permissionNames.includes(p),
    );
  }

  /**
   * Whether the actor is on the CRM task a LEGACY reservation serves.
   *
   * Asked only when the reservation cannot say which company requested it: that
   * is when the task relationship is the one authoritative requester-side
   * standing left, and nothing is guessed in its place — not the reservation's
   * old entityId label. A reservation that names its requester is decided by
   * that company alone, so CRM is not asked.
   */
  private async onTheTaskOfLegacy(
    parties: { requester: number | null },
    taskId: number | null,
    actor: WarehouseActor,
  ): Promise<boolean> {
    if (parties.requester !== null) return false;
    return this.reservations.isOnTask(taskId, actor.userId);
  }

  /**
   * Could this return be filed, right now — and what is actually out?
   *
   * Same authority, same measurement, nothing written. The outstanding figure is
   * read outside a transaction and is therefore informational; `create` measures
   * it again inside the one that writes.
   */
  async previewCreate(dto: CreateReturnDto, actor: WarehouseActor): Promise<ReturnPreview> {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: dto.reservationId },
      include: { item: { include: { category: { select: { entityId: true, name: true } } } } },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');

    const parties = await this.workspaces.partiesOfReservation(dto.reservationId);
    const verdict = decideOperation(actor, parties, 'return.create', {
      onTheTask: await this.onTheTaskOfLegacy(parties, reservation.taskId, actor),
    });
    if (!verdict.allowed) throw returnRefusal(verdict.because);

    /*
     * Assets are allocated one physical unit at a time, and a return says only a
     * number — so a return of "1" against three allocated drills cannot say WHICH
     * drill came back, and receiving it releases all three. That is not something
     * to let anything unattended file. Humans keep the route; see §I of the phase
     * notes.
     */
    if (reservation.item.type === ItemType.ASSET) {
      throw new BadRequestException(
        'Սարքավորման վերադարձը պետք է նշի, թե որ միավորն է վերադարձվում — այս ձևով հնարավոր չէ',
      );
    }

    const q = await quantitiesOf(this.prisma, dto.reservationId);
    if (dto.quantity > q.returnable) {
      throw new BadRequestException(
        `Հնարավոր չէ վերադարձնել ${dto.quantity} — տրված և դեռ չվերադարձված է միայն ${q.returnable}`,
      );
    }

    return {
      reservationId: reservation.id,
      itemId: reservation.itemId,
      itemName: reservation.item.name,
      unit: reservation.item.unit,
      reservationStatus: reservation.status,
      requesterWorkspaceId: parties.requester,
      stockOwnerWorkspaceId: parties.stockOwner,
      catalogueName: reservation.item.category?.name ?? null,
      requested: q.requested,
      issued: q.issued,
      returned: q.returned,
      out: q.out,
      returnable: q.returnable,
      returningNow: dto.quantity,
      outstandingIsInformational: true,
    };
  }

  async create(dto: CreateReturnDto, actor: WarehouseActor) {
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
    const returnable = roundQty(issued - alreadyPending);
    if (dto.quantity > returnable) {
      throw new BadRequestException(
        `Վերադարձվող քանակը (${dto.quantity}) գերազանցում է տրամադրված մնացորդը (${Math.max(0, returnable)})`,
      );
    }
    // Handing something back is the requester's act; the warehouse receives it.
    const parties = await this.workspaces.partiesOfReservation(dto.reservationId);
    const verdict = decideOperation(actor, parties, 'return.create', {
      onTheTask: await this.onTheTaskOfLegacy(parties, reservation.taskId, actor),
    });
    if (!verdict.allowed) throw returnRefusal(verdict.because);

    /*
     * Inside a transaction, and re-measured there: two people pressing return
     * at the same moment both passed the old check, because it read and then
     * wrote with nothing in between.
     */
    return this.prisma.$transaction(async (tx) => {
      /*
       * Before measuring. Two people handing back the same six both read "six
       * returnable" under READ COMMITTED and both filed — the live run caught
       * it. The second waits here and measures again with the first return in
       * view. See common/operations/row-lock.ts.
       */
      await lockReservation(tx as never, dto.reservationId);

      const { returnable } = await quantitiesOf(tx as never, dto.reservationId);
      if (returnable <= 0) {
        throw new BadRequestException(
          'Այս ամրագրման դիմաց վերադարձնելու բան չկա — ոչինչ տրամադրված չէ կամ ամեն ինչ արդեն վերադարձվել է',
        );
      }
      if (dto.quantity > returnable) {
        throw new BadRequestException(
          `Հնարավոր չէ վերադարձնել ${dto.quantity} — տրված և դեռ չվերադարձված է միայն ${returnable}`,
        );
      }

      return tx.resourceReturn.create({
        data: {
          reservationId: dto.reservationId,
          quantity: dto.quantity,
          notes: dto.notes ?? null,
          // Whoever holds the token, not whoever the body named.
          requestedBy: actor.userId,
        },
        include: this.include,
      });
    });
  }

  async findAll(
    filters: { status?: ResourceReturnStatus; taskId?: number; warehouseId?: string },
    actor: WarehouseActor,
  ) {
    if (!filters.taskId && !this.mayListEverything(actor)) {
      throw new ForbiddenException('Նշեք առաջադրանքը, որի վերադարձներն եք հարցնում');
    }
    /*
     * Naming a task was enough on its own until now: anybody with a token could
     * read any task's returns by guessing a number. Being on the task is the
     * answer for the people holding the goods; everybody else is judged per row
     * on the two companies behind it, because one task can draw on several
     * catalogues and a warehouse permission is not a pass into another company.
     */
    const onTheTask = filters.taskId
      ? await this.reservations.isOnTask(filters.taskId, actor.userId)
      : false;

    // #1989 workspaces: returns belong to the pool their reservation draws from.
    const reservationScope =
      filters.warehouseId === 'main'
        ? { warehouseId: null }
        : filters.warehouseId
          ? { warehouseId: Number(filters.warehouseId) }
          : {};
    const rows = await this.prisma.resourceReturn.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.taskId || filters.warehouseId
          ? { reservation: { ...(filters.taskId ? { taskId: filters.taskId } : {}), ...reservationScope } }
          : {}),
      },
      include: this.includeWithCatalogue,
      orderBy: { requestedAt: 'desc' },
    });

    const visible = rows.filter((r) =>
      mayRead(
        actor,
        {
          requester: r.reservation.requesterWorkspaceId ?? null,
          stockOwner:
            (r.reservation as { item?: { category?: { entityId?: number } } }).item?.category?.entityId ?? null,
        },
        { onTheTask, warehouseViewer: isWarehouseViewer(actor) },
      ),
    );
    if (!onTheTask && rows.length > 0 && visible.length === 0) {
      throw new NotFoundException('Task not found');
    }
    return visible;
  }

  async receive(id: number, receivedBy?: number, actor?: WarehouseActor) {
    const ret = await this.prisma.resourceReturn.findUnique({
      where: { id },
      include: { reservation: { include: { item: true } } },
    });

    if (!ret) throw new NotFoundException('Return not found');

    // Taking goods back onto a shelf is the warehouse's act: its permission,
    // whichever company asked and wherever the item is filed.
    if (actor) {
      const parties = await this.workspaces.partiesOfReturn(id);
      const verdict = decideOperation(actor, parties, 'return.receive');
      if (!verdict.allowed) throw new ForbiddenException('Վերադարձ ընդունելու համար պահեստի վերադարձների թույլտվություն է պետք');
    }
    if (ret.status !== ResourceReturnStatus.PENDING) {
      throw new BadRequestException('Վերադարձը սպասման կարգավիճակում չէ');
    }

    const isAsset = ret.reservation.item.type === ItemType.ASSET;

    const result = await this.prisma.$transaction(async (tx) => {
      // Ours: the row lock that stops two receipts racing.
      await lockReservation(tx as never, ret.reservationId);

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
            data: { quantity: roundQty(rowQty - take) },
          });
          await tx.reservationAllocation.create({
            data: { reservationId: ret.reservationId, quantity: take, releasedAt: new Date() },
          });
        }
        remaining = roundQty(remaining - take);
      }
      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: ret.reservationId,
          action: 'RELEASED',
          performedBy: receivedBy,
          notes: `Վերադարձ #${ret.id} ստացված — ${ret.quantity} հատ`,
        },
      });

      const newIssued = roundQty(issued - ret.quantity);
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
        await settleStoredQty(tx, { itemId: ret.reservation.itemId, warehouseId: whId });

        // The request shrinks by what came back; acceptance can never exceed
        // either the new request or what is still out.
        const newQuantity = roundQty(Math.max(0, ret.reservation.quantity - ret.quantity));
        const accepted = (ret.reservation as any).acceptedQuantity ?? 0;
        // Returned goods are no longer kept: acceptance can exceed neither the
        // shrunken request nor what is still physically out.
        const newAccepted = roundQty(Math.min(accepted, newQuantity, newIssued));

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


      const rc = await this.reverseCostInfo(tx, {
        taskId: ret.reservation.taskId,
        itemId: ret.reservation.itemId,
        warehouseId: (ret.reservation as any).warehouseId ?? null,
        fallbackObjectId: (ret.reservation as any).objectId ?? null,
      });
      await tx.inventoryMovement.create({
        data: {
          itemId: ret.reservation.itemId,
          quantity: ret.quantity,
          type: 'IN',
          taskId: ret.reservation.taskId,
          warehouseId: (ret.reservation as any).warehouseId ?? null,
          objectId: rc.objectId,
          unitCost: rc.unitCost,
          totalCost: rc.unitCost != null ? ret.quantity * rc.unitCost : null,
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

  async cancel(id: number, actor?: WarehouseActor) {
    const ret = await this.prisma.resourceReturn.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException('Return not found');

    // Either party may call off a return that has not happened yet.
    if (actor) {
      const parties = await this.workspaces.partiesOfReturn(id);
      const verdict = decideOperation(actor, parties, 'return.cancel');
      if (!verdict.allowed) {
        throw new ForbiddenException('Վերադարձը կարող են չեղարկել պահանջողը կամ պահեստի վերադարձների թույլտվություն ունեցողը');
      }
    }
    if (ret.status !== ResourceReturnStatus.PENDING) {
      throw new BadRequestException('Միայն սպասող վերադարձները կարելի է չեղարկել');
    }

    return this.prisma.resourceReturn.update({
      where: { id },
      data: { status: ResourceReturnStatus.CANCELLED },
      include: this.include,
    });
  }
}

/**
 * Why a return could not be filed. The two requester-side refusals are not the
 * same problem: one is another company's work, the other is a legacy
 * reservation whose requester nobody can name and whose task the caller is not on.
 */
function returnRefusal(because: string) {
  return new ForbiddenException(
    because === 'unknown-workspace'
      ? 'Պարզ չէ, թե որ կազմակերպությունն է պահանջել այս ամրագրումը, և դուք դրա առաջադրանքում չեք, ուստի պահանջողի անունից վերադարձնել հնարավոր չէ'
      : 'Սա այլ կազմակերպության վերադարձն է',
  );
}
