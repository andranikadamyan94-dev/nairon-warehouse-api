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

  async findAll(query?: { status?: string; supplierId?: string; search?: string; page?: string; limit?: string; sortBy?: string; sortOrder?: string }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);

    const where: any = {};
    if (query?.status) where.status = query.status;
    if (query?.supplierId) where.supplierId = Number(query.supplierId);
    if (query?.search) {
      where.OR = [
        { supplier: { name: { contains: query.search, mode: 'insensitive' } } },
        { notes: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const order: 'asc' | 'desc' = query?.sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: any = query?.sortBy === 'status' ? { status: order } : { createdAt: query?.sortBy === 'createdAt' ? order : 'desc' };

    const [data, total] = await Promise.all([
      this.prisma.procurementOrder.findMany({
        where,
        include,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.procurementOrder.count({ where }),
    ]);

    return { data, total, page, limit };
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
    if (order.status === ProcurementOrderStatus.PENDING_FINANCE_APPROVAL) {
      throw new BadRequestException('Order is awaiting finance approval');
    }
    if (order.status === ProcurementOrderStatus.DRAFT) {
      throw new BadRequestException('Order must be finance-approved before receiving');
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

  async finalize(id: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.DRAFT) {
      throw new BadRequestException('Only DRAFT orders can be finalized');
    }

    const total = order.items.reduce(
      (sum, i) => sum + i.quantity * (i.unitPrice ?? 0),
      0,
    );

    const financeUrl = process.env.FINANCE_API_URL || 'http://localhost:3005';
    let financeTransferId: number | undefined;
    try {
      const res = await fetch(`${financeUrl}/api/transfer/external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-key': process.env.INTERNAL_API_KEY || '' },
        body: JSON.stringify({
          amount: total,
          description: `Procurement order #${id}${order.supplier ? ` — ${order.supplier.name}` : ''}`,
          externalRef: `warehouse_procurement:${id}`,
          date: new Date().toISOString(),
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { id: number };
        financeTransferId = data.id;
      }
    } catch {}

    return this.prisma.procurementOrder.update({
      where: { id },
      data: {
        status: ProcurementOrderStatus.PENDING_FINANCE_APPROVAL,
        ...(financeTransferId ? { financeTransferId } : {}),
      },
      include,
    });
  }

  async financeCallback(id: number, status: 'APPROVED' | 'REJECTED') {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.PENDING_FINANCE_APPROVAL) {
      throw new BadRequestException('Order is not pending finance approval');
    }
    return this.prisma.procurementOrder.update({
      where: { id },
      data: {
        status:
          status === 'APPROVED'
            ? ProcurementOrderStatus.FINANCE_APPROVED
            : ProcurementOrderStatus.DRAFT,
      },
      include,
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
