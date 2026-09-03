import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { UsersPrismaService } from '../common/users-prisma.service';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { ItemType } from '../common/enums/item-type.enum';

/**
 * Main → project-warehouse transfers (#1989). One item per document (the
 * printed transfer-waybill form), confirmed atomically: main pool
 * (Item.quantity) down with an OUT movement, sub stock up with an IN movement
 * carrying the warehouseId. No sub→sub or sub→main flows — per the task, subs
 * are replenished ONLY from main.
 */
@Injectable()
export class StockTransfersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersPrisma: UsersPrismaService,
    private readonly stockAlerts: StockAlertService,
  ) {}

  async create(
    dto: {
      toWarehouseId: number;
      backlogId?: number;
      itemId: number;
      quantity: number;
      transferDate?: string;
      issuedById?: number;
      receivedById?: number;
      comment?: string;
    },
    createdBy?: number,
  ) {
    const quantity = Number(dto.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new BadRequestException('Քանակը պետք է լինի ամբողջ դրական թիվ');
    }

    const [wh, item] = await Promise.all([
      this.prisma.warehouse.findUnique({ where: { id: dto.toWarehouseId }, include: { backlogs: true } }),
      this.prisma.item.findUnique({ where: { id: dto.itemId } }),
    ]);
    if (!wh) throw new NotFoundException('Պահեստը չի գտնվել');
    if (wh.type !== 'PROJECT') {
      throw new BadRequestException('Փոխանցումը հնարավոր է միայն նախագծային պահեստ');
    }
    if (wh.status !== 'ACTIVE') {
      throw new BadRequestException('Պահեստը ակտիվ չէ');
    }
    if (!item) throw new NotFoundException('Ապրանքը չի գտնվել');
    if (item.type !== ItemType.CONSUMABLE) {
      throw new BadRequestException('Փոխանցվում են միայն ծախսվող ապրանքները (ակտիվները՝ հաջորդ փուլում)');
    }
    if (dto.backlogId && !wh.backlogs.some((b) => b.backlogId === dto.backlogId)) {
      throw new BadRequestException('Նշված նախագիծը կապված չէ այս պահեստի հետ');
    }

    const transfer = await this.prisma.$transaction(async (tx) => {
      // Guarded decrement — the WHERE keeps the main pool non-negative under
      // concurrent transfers/issuances.
      const dec = await tx.item.updateMany({
        where: { id: item.id, quantity: { gte: quantity } },
        data: { quantity: { decrement: quantity } },
      });
      if (dec.count === 0) {
        throw new BadRequestException('Հիմնական պահեստում բավարար պաշար չկա');
      }

      await tx.warehouseStock.upsert({
        where: { warehouseId_itemId: { warehouseId: wh.id, itemId: item.id } },
        update: { quantity: { increment: quantity } },
        create: { warehouseId: wh.id, itemId: item.id, quantity },
      });

      const created = await tx.stockTransfer.create({
        data: {
          toWarehouseId: wh.id,
          backlogId: dto.backlogId ?? null,
          itemId: item.id,
          quantity,
          transferDate: dto.transferDate ? new Date(dto.transferDate) : new Date(),
          issuedById: dto.issuedById ?? null,
          receivedById: dto.receivedById ?? null,
          comment: dto.comment?.trim() || null,
          createdBy: createdBy ?? null,
        },
      });

      await tx.inventoryMovement.create({
        data: {
          itemId: item.id,
          quantity: -quantity,
          type: 'OUT',
          performedBy: createdBy ?? null,
          notes: `Փոխանցում #${created.id} → ${wh.name}`,
        },
      });
      await tx.inventoryMovement.create({
        data: {
          itemId: item.id,
          quantity,
          type: 'IN',
          warehouseId: wh.id,
          performedBy: createdBy ?? null,
          notes: `Փոխանցում #${created.id} ← Հիմնական պահեստ`,
        },
      });

      return created;
    });

    // Main pool shrank — low-stock check, outside the transaction as always.
    this.stockAlerts.check([item.id]);

    return this.enrich([transfer]).then((r) => r[0]);
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
    if (query?.itemId) where.itemId = Number(query.itemId);

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockTransfer.findMany({
        where,
        include: {
          toWarehouse: { select: { id: true, name: true, code: true } },
          item: { select: { id: true, name: true, code: true, unit: true } },
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.stockTransfer.count({ where }),
    ]);

    return { data: await this.enrich(rows), total, page, limit };
  }

  /** Resolve users-DB names for the three people on the document. */
  private async enrich(rows: any[]) {
    const ids = [
      ...new Set(
        rows
          .flatMap((r) => [r.issuedById, r.receivedById, r.createdBy])
          .filter((x): x is number => x != null),
      ),
    ];
    const users = await this.usersPrisma.getUsersByIds(ids);
    const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return rows.map((r) => ({
      ...r,
      issuedByName: r.issuedById ? nameOf.get(r.issuedById) ?? null : null,
      receivedByName: r.receivedById ? nameOf.get(r.receivedById) ?? null : null,
    }));
  }
}
