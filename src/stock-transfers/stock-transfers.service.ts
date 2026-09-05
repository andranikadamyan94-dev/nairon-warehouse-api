import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { StockAlertService } from '../common/notifications/stock-alert.service';
import { ItemType } from '../common/enums/item-type.enum';

/**
 * Main ↔ project-warehouse transfers (#1989). One DOCUMENT with many item
 * lines (the printed transfer-waybill form), confirmed atomically per line.
 * TO_SUB replenishes a sub from main; TO_MAIN is the correction/return path.
 * Consumables move quantity between pools (Item.quantity ↔ WarehouseStock);
 * assets move by re-homing N transferable rows (AVAILABLE, unallocated) —
 * the system picks them oldest-first, like allocation auto-pick.
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
      direction?: 'TO_SUB' | 'TO_MAIN';
      items: { itemId: number; quantity: number }[];
      transferDate?: string;
      comment?: string;
    },
    createdBy?: number,
  ) {
    const direction = dto.direction === 'TO_MAIN' ? 'TO_MAIN' : 'TO_SUB';
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
      throw new BadRequestException('Փոխանցումը հնարավոր է միայն նախագծային պահեստի հետ');
    }
    // TO_SUB into an inactive sub is refused; TO_MAIN (draining one) is fine.
    if (direction === 'TO_SUB' && wh.status !== 'ACTIVE') {
      throw new BadRequestException('Պահեստը ակտիվ չէ');
    }
    const itemOf = new Map(items.map((i) => [i.id, i]));
    for (const l of lines) {
      if (!itemOf.get(l.itemId)) throw new NotFoundException(`Ապրանքը չի գտնվել (#${l.itemId})`);
    }

    const transfer = await this.prisma.$transaction(async (tx) => {
      const created = await tx.stockTransfer.create({
        data: {
          toWarehouseId: wh.id,
          direction,
          transferDate: dto.transferDate ? new Date(dto.transferDate) : new Date(),
          comment: dto.comment?.trim() || null,
          createdBy: createdBy ?? null,
          items: { create: lines },
        },
      });

      for (const l of lines) {
        const item = itemOf.get(l.itemId)!;
        // source/destination pools: null = main
        const sourceWh = direction === 'TO_SUB' ? null : wh.id;
        const destWh = direction === 'TO_SUB' ? wh.id : null;

        if (item.type === ItemType.ASSET) {
          // Move N transferable rows (AVAILABLE, no active allocation).
          const candidates = await tx.asset.findMany({
            where: {
              itemId: l.itemId,
              warehouseId: sourceWh,
              status: 'AVAILABLE',
              allocations: { none: { releasedAt: null } },
            },
            orderBy: { id: 'asc' },
            take: l.quantity,
            select: { id: true },
          });
          if (candidates.length < l.quantity) {
            throw new BadRequestException(
              `«${item.name}»՝ աղբյուր պահեստում փոխանցելի ակտիվ չկա բավարար քանակով (${candidates.length}/${l.quantity})`,
            );
          }
          // Guarded — a concurrent transfer/allocation must not steal a row.
          const moved = await tx.asset.updateMany({
            where: { id: { in: candidates.map((c) => c.id) }, warehouseId: sourceWh },
            data: { warehouseId: destWh },
          });
          if (moved.count !== l.quantity) {
            throw new BadRequestException(`«${item.name}»՝ ակտիվները զբաղված են, փորձեք կրկին`);
          }
        } else {
          if (direction === 'TO_SUB') {
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
          } else {
            const dec = await tx.warehouseStock.updateMany({
              where: { warehouseId: wh.id, itemId: l.itemId, quantity: { gte: l.quantity } },
              data: { quantity: { decrement: l.quantity } },
            });
            if (dec.count === 0) {
              throw new BadRequestException(`«${item.name}»՝ նախագծային պահեստում բավարար պաշար չկա`);
            }
            await tx.item.update({
              where: { id: l.itemId },
              data: { quantity: { increment: l.quantity } },
            });
          }
        }

        const label = direction === 'TO_SUB'
          ? { out: `Փոխանցում #${created.id} → ${wh.name}`, in: `Փոխանցում #${created.id} ← Հիմնական պահեստ` }
          : { out: `Փոխանցում #${created.id} → Հիմնական պահեստ`, in: `Փոխանցում #${created.id} ← ${wh.name}` };
        // #2042: transfers carry the current cost along (no object — pool moves).
        const trCost = (item as any).unitCost ?? null;
        await tx.inventoryMovement.create({
          data: {
            itemId: l.itemId,
            quantity: -l.quantity,
            type: 'OUT',
            warehouseId: direction === 'TO_SUB' ? null : wh.id,
            unitCost: trCost,
            totalCost: trCost != null ? l.quantity * trCost : null,
            performedBy: createdBy ?? null,
            notes: label.out,
          },
        });
        await tx.inventoryMovement.create({
          data: {
            itemId: l.itemId,
            quantity: l.quantity,
            type: 'IN',
            warehouseId: direction === 'TO_SUB' ? wh.id : null,
            unitCost: trCost,
            totalCost: trCost != null ? l.quantity * trCost : null,
            performedBy: createdBy ?? null,
            notes: label.in,
          },
        });
      }

      return tx.stockTransfer.findUnique({
        where: { id: created.id },
        include: {
          items: { include: { item: { select: { id: true, name: true, code: true, unit: true, type: true } } } },
          toWarehouse: { select: { id: true, name: true, code: true } },
        },
      });
    });

    // Only main-pool consumable levels feed the low-stock latch today.
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
          items: { include: { item: { select: { id: true, name: true, code: true, unit: true, type: true } } } },
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
