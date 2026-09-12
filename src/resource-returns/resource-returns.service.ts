import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';
import { ItemType } from '../common/enums/item-type.enum';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';
import { ReservationsService } from '../reservations/reservations.service';
import { decideOperation, isWarehouseViewer, mayRead } from '../reservations/two-party';

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
   * How much of this reservation could still honestly come back.
   *
   * The old rule measured against the REQUESTED quantity and counted only
   * PENDING returns. Both halves were wrong in the same direction. Ask for 5,
   * be issued 2, and a return of 5 was accepted — and receiving it added 5 to
   * the shelf, three of which had never left it. Stock could be invented by
   * asking for more than you were given.
   *
   * What can come back is what went out and has not come back yet: the live
   * allocations, less everything already returned or waiting to be.
   */
  private async returnableQuantity(reservationId: number, tx = this.prisma): Promise<number> {
    const [issued, returned] = await Promise.all([
      tx.reservationAllocation.aggregate({
        where: { reservationId, releasedAt: null },
        _sum: { quantity: true },
      }),
      tx.resourceReturn.aggregate({
        where: {
          reservationId,
          status: { in: [ResourceReturnStatus.PENDING, ResourceReturnStatus.RECEIVED] },
        },
        _sum: { quantity: true },
      }),
    ]);
    return (issued._sum.quantity ?? 0) - (returned._sum.quantity ?? 0);
  }

  async create(dto: CreateReturnDto, actor: WarehouseActor) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: dto.reservationId },
      include: { item: true },
    });

    if (!reservation) throw new NotFoundException('Reservation not found');

    // Handing something back is the requester's act; the shelf owner receives it.
    const parties = await this.workspaces.partiesOfReservation(dto.reservationId);
    const verdict = decideOperation(actor, parties, 'return.create');
    if (!verdict.allowed) {
      throw new ForbiddenException(
        verdict.because === 'unknown-workspace'
          ? 'This reservation cannot say which company asked for it, so nothing can be returned against it from inside one'
          : 'This is another company’s to hand back',
      );
    }

    /*
     * Inside a transaction, and re-measured there: two people pressing return
     * at the same moment both passed the old check, because it read and then
     * wrote with nothing in between.
     */
    return this.prisma.$transaction(async (tx) => {
      const returnable = await this.returnableQuantity(dto.reservationId, tx as never);
      if (returnable <= 0) {
        throw new BadRequestException(
          'Այս ամրագրման դիմաց վերադարձնելու բան չկա — ոչինչ տրամադրված չէ կամ ամեն ինչ արդեն վերադարձվել է',
        );
      }
      if (dto.quantity > returnable) {
        throw new BadRequestException(
          `Cannot return ${dto.quantity} units — only ${returnable} are out and not yet returned`,
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

  async findAll(filters: { status?: ResourceReturnStatus; taskId?: number }, actor: WarehouseActor) {
    if (!filters.taskId && !this.mayListEverything(actor)) {
      throw new ForbiddenException('Name the task whose returns you are asking about');
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

    const rows = await this.prisma.resourceReturn.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.taskId ? { reservation: { taskId: filters.taskId } } : {}),
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

    // Taking goods back onto a shelf is the shelf owner's act.
    if (actor) {
      const parties = await this.workspaces.partiesOfReturn(id);
      const verdict = decideOperation(actor, parties, 'return.receive');
      if (!verdict.allowed) throw new ForbiddenException('This is another company’s stock to take back');
    }
    if (ret.status !== ResourceReturnStatus.PENDING) {
      throw new BadRequestException('Return is not in PENDING status');
    }

    const isAsset = ret.reservation.item.type === ItemType.ASSET;

    const result = await this.prisma.$transaction(async (tx) => {
      if (isAsset) {
        // Assets are tracked individually — release all active allocations for this reservation
        await tx.reservationAllocation.updateMany({
          where: { reservationId: ret.reservationId, releasedAt: null },
          data: { releasedAt: new Date() },
        });
        await tx.resourceReservation.update({
          where: { id: ret.reservationId },
          data: { status: ResourceReservationStatus.COMPLETED },
        });
      } else {
        // Consumable: restore item stock
        await tx.item.update({
          where: { id: ret.reservation.itemId },
          data: { quantity: { increment: ret.quantity } },
        });

        const newQty = ret.reservation.quantity - ret.quantity;
        await tx.resourceReservation.update({
          where: { id: ret.reservationId },
          data: {
            quantity: newQty <= 0 ? 0 : newQty,
            status: newQty <= 0 ? ResourceReservationStatus.COMPLETED : undefined,
          },
        });

        const allocation = await tx.reservationAllocation.findFirst({
          where: { reservationId: ret.reservationId, releasedAt: null },
        });
        if (allocation) {
          const remainingAlloc = allocation.quantity - ret.quantity;
          await tx.reservationAllocation.update({
            where: { id: allocation.id },
            data: remainingAlloc <= 0
              ? { releasedAt: new Date() }
              : { quantity: remainingAlloc },
          });
        }
      }

      await tx.inventoryMovement.create({
        data: {
          itemId: ret.reservation.itemId,
          quantity: ret.quantity,
          type: 'IN',
          taskId: ret.reservation.taskId,
          performedBy: receivedBy,
          notes: `Return #${ret.id} received`,
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
      if (!verdict.allowed) throw new ForbiddenException('This is another company’s return to call off');
    }
    if (ret.status !== ResourceReturnStatus.PENDING) {
      throw new BadRequestException('Only pending returns can be cancelled');
    }

    return this.prisma.resourceReturn.update({
      where: { id },
      data: { status: ResourceReturnStatus.CANCELLED },
      include: this.include,
    });
  }
}
