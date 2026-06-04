import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { ProcurementOrderStatus } from '../common/enums/procurement-order-status.enum';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';

const include = {
  supplier: true,
  items: { include: { item: true } },
};

@Injectable()
export class ProcurementService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.procurementOrder.findMany({
      include,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: number) {
    const order = await this.prisma.procurementOrder.findUnique({ where: { id }, include });
    if (!order) throw new NotFoundException('Procurement order not found');
    return order;
  }

  async create(dto: CreateProcurementDto) {
    return this.prisma.procurementOrder.create({
      data: {
        supplierId: dto.supplierId ?? null,
        notes: dto.notes ?? null,
        items: {
          create: dto.items.map((i) => ({
            itemId: i.itemId,
            quantity: i.quantity,
            unitPrice: i.unitPrice ?? null,
          })),
        },
      },
      include,
    });
  }

  async update(id: number, dto: UpdateProcurementDto) {
    const order = await this.findOne(id);
    if (order.status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Cannot edit a received order');
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.items !== undefined) {
        await tx.procurementOrderItem.deleteMany({ where: { orderId: id } });
        await tx.procurementOrderItem.createMany({
          data: dto.items.map((i) => ({
            orderId: id,
            itemId: i.itemId,
            quantity: i.quantity,
            unitPrice: i.unitPrice ?? null,
          })),
        });
      }

      return tx.procurementOrder.update({
        where: { id },
        data: {
          supplierId: dto.supplierId ?? undefined,
          notes: dto.notes ?? undefined,
        },
        include,
      });
    });
  }

  async updateStatus(id: number, status: ProcurementOrderStatus) {
    const order = await this.findOne(id);
    if (order.status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Order already received');
    }
    if (order.status === ProcurementOrderStatus.CANCELLED) {
      throw new BadRequestException('Order is cancelled');
    }
    return this.prisma.procurementOrder.update({
      where: { id },
      data: { status },
      include,
    });
  }

  async receive(id: number) {
    const order = await this.findOne(id);
    if (order.status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Order already received');
    }
    if (order.status === ProcurementOrderStatus.CANCELLED) {
      throw new BadRequestException('Order is cancelled');
    }

    return this.prisma.$transaction(async (tx) => {
      for (const line of order.items) {
        if (line.item.type === 'ASSET') {
          const count = Math.round(line.quantity);
          for (let i = 0; i < count; i++) {
            await tx.asset.create({ data: { itemId: line.itemId } });
          }
        } else {
          await tx.item.update({
            where: { id: line.itemId },
            data: { quantity: { increment: line.quantity } },
          });
        }

        await tx.inventoryMovement.create({
          data: {
            itemId: line.itemId,
            quantity: line.quantity,
            type: 'IN',
            notes: `Procurement order #${id} received`,
          },
        });
      }

      return tx.procurementOrder.update({
        where: { id },
        data: {
          status: ProcurementOrderStatus.RECEIVED,
          receivedAt: new Date(),
        },
        include,
      });
    });
  }

  async remove(id: number) {
    const order = await this.findOne(id);
    if (order.status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Cannot delete a received order');
    }
    return this.prisma.procurementOrder.delete({ where: { id } });
  }
}
