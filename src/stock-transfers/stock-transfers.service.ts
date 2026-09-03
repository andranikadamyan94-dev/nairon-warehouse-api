import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { StockAlertService } from '../common/notifications/stock-alert.service';
import { ItemType } from '../common/enums/item-type.enum';

/**
 * Main → project-warehouse transfers (#1989). One DOCUMENT with many item
 * lines (the printed transfer-waybill form), confirmed atomically per line:
 * main pool (Item.quantity) down with an OUT movement, sub stock up with an
 * IN movement carrying the warehouseId. No sub→sub or sub→main flows — per
 * the task, subs are replenished ONLY from main.
 */
@Injectable()
export class StockTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockAlerts: StockAlertService,
  ) {}

  async create(
    dto: {
      toWarehouseId: number;
      items: { itemId: number; quantity: number }[];
      transferDate?: string;
      comment?: string;
    },
    createdBy?: number,
  ) {
    const lines = (dto.items ?? []).map((l) => ({ itemId: Number(l.itemId), quantity: Number(l.quantity) }));
    if (!lines.length) {
      throw new BadRequestException('Ավելացրեք գոնե մեկ ապրանք');
    }
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 1) {
        throw new BadRequestException('Քանակը պետք է լինի ամբողջ դրական թիվ');
      }
    }
    if (new Set(lines.map((l) => l.itemId)).size !== lines.length) {
      throw new BadRequestException('Նույն ապրանքը կրկնվում է');
    }

    const [wh, items] = await Promise.all([
      this.prisma.warehouse.findUnique({ where: { id: dto.toWarehouseId } }),
      this.prisma.item.findMany({ where: { id: { in: lines.map((l) => l.itemId) } } }),
    ]);
    if (!wh) throw new NotFoundException('Պահեստը չի գտնվել');
    if (wh.type !== 'PROJECT') {
      throw new BadRequestException('Փոխանցումը հնարավոր է միայն նախագծային պահեստ');
    }
    if (wh.status !== 'ACTIVE') {
      throw new BadRequestException('Պահեստը ակտիվ չէ');
    }
    const itemOf = new Map(items.map((i) => [i.id, i]));
    for (const l of lines) {
      const item = itemOf.get(l.itemId);
      if (!item) throw new NotFoundException(`Ապրանքը չի գտնվել (#${l.itemId})`);
      if (item.type !== ItemType.CONSUMABLE) {
        throw new BadRequestException(`«${item.name}»՝ փոխանցվում են միայն ծախսվող ապրանքները (ակտիվները՝ հաջորդ փուլում)`);
      }
    }

    const transfer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stockTransfer.create({
        data: {
          toWarehouseId: wh.id,
          transferDate: dto.transferDate ? new Date(dto.transferDate) : new Date(),
          comment: dto.comment?.trim() || null,
          createdBy: createdBy ?? null,
          items: { create: lines },
        },
      });

      for (const l of lines) {
        const item = itemOf.get(l.itemId)!;
        // Guarded decrement — concurrent transfers/issuances must not drive
        // the main pool negative.
        const dec = await tx.item.updateMany({
          where: { id: l.itemId, quantity: { gte: l.quantity } },
          data: { quantity: { decrement: l.quantity } },
        });
        if (dec.count === 0) {
          throw new BadRequestException(`«${item.name}»՝ հիմնական պահեստում բավարար պաշար չկա`);
        }

        await tx.warehouseStock.upsert({
          where: { warehouseId_itemId: { warehouseId: wh.id, itemId: l.itemId } },
          update: { quantity: { increment: l.quantity } },
          create: { warehouseId: wh.id, itemId: l.itemId, quantity: l.quantity },
        });

        await tx.inventoryMovement.create({
          data: {
            itemId: l.itemId,
            quantity: -l.quantity,
            type: 'OUT',
            performedBy: createdBy ?? null,
            notes: `Փոխանցում #${created.id} → ${wh.name}`,
          },
        });
        await tx.inventoryMovement.create({
          data: {
            itemId: l.itemId,
            quantity: l.quantity,
            type: 'IN',
            warehouseId: wh.id,
            performedBy: createdBy ?? null,
            notes: `Փոխանցում #${created.id} ← Հիմնական պահեստ`,
          },
        });
      }

      return tx.stockTransfer.findUnique({
        where: { id: created.id },
        include: {
          items: { include: { item: { select: { id: true, name: true, code: true, unit: true } } } },
          toWarehouse: { select: { id: true, name: true, code: true } },
        },
      });
    });

    // Main pool shrank — low-stock check, outside the transaction as always.
    this.stockAlerts.check(lines.map((l) => l.itemId));

    return transfer;
  }

  async findAll(query?: {
    page?: string;
    limit?: string;
    toWarehouseId?: string;
    itemId?: string;
  }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);
    const where: any = {};
    if (query?.toWarehouseId) where.toWarehouseId = Number(query.toWarehouseId);
    if (query?.itemId) where.items = { some: { itemId: Number(query.itemId) } };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockTransfer.findMany({
        where,
        include: {
          toWarehouse: { select: { id: true, name: true, code: true } },
          items: { include: { item: { select: { id: true, name: true, code: true, unit: true } } } },
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);

    return { data: rows, total, page, limit };
  }
}
