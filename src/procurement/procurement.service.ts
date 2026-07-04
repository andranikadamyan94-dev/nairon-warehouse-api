import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { ProcurementOrderStatus } from '../common/enums/procurement-order-status.enum';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { FileService } from '../common/file.service';

const include = {
  supplier: true,
  items: { include: { item: true } },
};

@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
  ) {}

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

  async receive(id: number, receiptFile?: Express.Multer.File) {
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
    if (order.status === ProcurementOrderStatus.FINANCE_REJECTED) {
      throw new BadRequestException('Order was finance-rejected and cannot be received');
    }
    if (!receiptFile) {
      throw new BadRequestException('Receipt file is required when marking an order as received');
    }

    const receiptUrl = this.fileService.upload(receiptFile);

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
            supplierId: order.supplierId ?? undefined,
            notes: `Procurement order #${id} received`,
          },
        });
      }

      return tx.procurementOrder.update({
        where: { id },
        data: {
          status: ProcurementOrderStatus.RECEIVED,
          receivedAt: new Date(),
          receiptUrl,
        },
        include,
      });
    });
  }

  async resubmit(id: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.FINANCE_REJECTED) {
      throw new BadRequestException('Only FINANCE_REJECTED orders can be resubmitted');
    }
    return this.prisma.procurementOrder.update({
      where: { id },
      data: { status: ProcurementOrderStatus.DRAFT },
      include,
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
    const internalKey = process.env.INTERNAL_SECRET || '';
    console.log(`[procurement:finalize] calling finance-api: POST ${financeUrl}/api/transfer/external | key_set=${!!internalKey} | key_len=${internalKey.length}`);

    let financeTransferId: number | undefined;
    let financeError: string | undefined;
    try {
      const res = await fetch(`${financeUrl}/api/transfer/external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': internalKey },
        body: JSON.stringify({
          amount: total,
          description: `Procurement order #${id}${order.supplier ? ` — ${order.supplier.name}` : ''}`,
          externalRef: `warehouse_procurement:${id}`,
          date: new Date().toISOString(),
        }),
      });
      const body = await res.text();
      console.log(`[procurement:finalize] finance-api response: status=${res.status} body=${body}`);
      if (res.ok) {
        financeTransferId = JSON.parse(body).id;
      } else {
        financeError = `finance-api ${res.status} (url: ${financeUrl}): ${body}`;
      }
    } catch (e: any) {
      financeError = `network error reaching ${financeUrl}: ${e?.message ?? e}`;
      console.error(`[procurement:finalize] ${financeError}`);
    }

    if (financeError) {
      throw new BadRequestException(`Finance notification failed — ${financeError}`);
    }

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
            : ProcurementOrderStatus.FINANCE_REJECTED,
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
