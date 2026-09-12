import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';
import { ItemType } from '../common/enums/item-type.enum';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { WarehouseActor } from '../auth/actor';

@Injectable()
export class ResourceReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockAlerts: StockAlertService,
  ) {}

  private readonly include = {
    reservation: {
      include: { item: true },
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

  async create(dto: CreateReturnDto, actor: WarehouseActor) {
    const reservation = await this.prisma.resourceReservation.findUnique({
      where: { id: dto.reservationId },
      include: { item: true },
    });

    if (!reservation) throw new NotFoundException('Reservation not found');

    if (reservation.item.type === ItemType.CONSUMABLE) {
      const pendingQty = await this.prisma.resourceReturn.aggregate({
        where: { reservationId: dto.reservationId, status: ResourceReturnStatus.PENDING },
        _sum: { quantity: true },
      });
      const alreadyPending = pendingQty._sum.quantity ?? 0;
      if (dto.quantity + alreadyPending > reservation.quantity) {
        throw new BadRequestException(
          `Cannot return ${dto.quantity} units — only ${reservation.quantity - alreadyPending} units remain available for return`,
        );
      }
    }

    return this.prisma.resourceReturn.create({
      data: {
        reservationId: dto.reservationId,
        quantity: dto.quantity,
        notes: dto.notes ?? null,
        // Whoever holds the token, not whoever the body named.
        requestedBy: actor.userId,
      },
      include: this.include,
    });
  }

  findAll(filters: { status?: ResourceReturnStatus; taskId?: number }, actor: WarehouseActor) {
    if (!filters.taskId && !this.mayListEverything(actor)) {
      throw new ForbiddenException('Name the task whose returns you are asking about');
    }

    return this.prisma.resourceReturn.findMany({
      where: {
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.taskId ? { reservation: { taskId: filters.taskId } } : {}),
      },
      include: this.include,
      orderBy: { requestedAt: 'desc' },
    });
  }

  async receive(id: number, receivedBy?: number) {
    const ret = await this.prisma.resourceReturn.findUnique({
      where: { id },
      include: { reservation: { include: { item: true } } },
    });

    if (!ret) throw new NotFoundException('Return not found');
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

  async cancel(id: number) {
    const ret = await this.prisma.resourceReturn.findUnique({ where: { id } });
    if (!ret) throw new NotFoundException('Return not found');
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
