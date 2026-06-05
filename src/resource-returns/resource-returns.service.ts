import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateReturnDto } from './dto/create-return.dto';
import { ResourceReturnStatus } from '../common/enums/resource-return-status.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';
import { ItemType } from '../common/enums/item-type.enum';

@Injectable()
export class ResourceReturnsService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly include = {
    reservation: {
      include: { item: true },
    },
  };

  async create(dto: CreateReturnDto) {
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
        requestedBy: dto.requestedBy ?? null,
      },
      include: this.include,
    });
  }

  findAll(filters: { status?: ResourceReturnStatus; taskId?: number }) {
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

    return this.prisma.$transaction(async (tx) => {
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
