import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { StockAlertService } from '../common/notifications/stock-alert.service';
import { UsersPrismaService } from '../common/users-prisma.service';

import { ItemType } from '../common/enums/item-type.enum';

import {
  InventoryMovementDto,
  InventoryMovementType,
} from './dto/inventory-movement.dto';

@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stockAlerts: StockAlertService,
    private readonly usersPrisma: UsersPrismaService,
  ) {}

  async createMovement(dto: InventoryMovementDto) {
    const item = await this.prisma.item.findUnique({
      where: {
        id: dto.itemId,
      },
    });

    if (!item) {
      throw new NotFoundException('Item not found');
    }

    if (item.type !== ItemType.CONSUMABLE) {
      throw new BadRequestException(
        'Inventory movements only supported for consumables',
      );
    }

    let newQuantity = item.quantity;

    switch (dto.type) {
      case InventoryMovementType.IN:
        newQuantity += dto.quantity;
        break;

      case InventoryMovementType.OUT:
      case InventoryMovementType.RESERVATION:
        newQuantity -= dto.quantity;
        break;

      case InventoryMovementType.RELEASE:
        newQuantity += dto.quantity;
        break;

      case InventoryMovementType.ADJUSTMENT:
        newQuantity = dto.quantity;
        break;
    }

    if (newQuantity < 0) {
      throw new BadRequestException('Insufficient inventory quantity');
    }

    const movement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.inventoryMovement.create({
        data: dto,
      });

      await tx.item.update({
        where: {
          id: item.id,
        },
        data: {
          quantity: newQuantity,
        },
      });

      return created;
    });

    // After commit, never inside the transaction — see StockAlertService.
    this.stockAlerts.check([item.id]);

    return movement;
  }

  /**
   * The movements ledger (2026-09-02 page + waybill export): filterable and
   * paginated, with performer names resolved from the shared users DB so the
   * page never shows bare ids.
   */
  async getMovements(query?: {
    itemId?: string;
    taskId?: string;
    type?: string;
    from?: string;
    to?: string;
    page?: string;
    limit?: string;
    warehouseId?: string;
    objectId?: string;
  }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);
    const where: any = {};
    if (query?.itemId) where.itemId = Number(query.itemId);
    if (query?.taskId) where.taskId = Number(query.taskId);
    if (query?.type) where.type = query.type;
    // 'main' = the null-warehouse ledger (main pool, incl. all pre-1989 rows)
    if (query?.warehouseId === 'main') where.warehouseId = null;
    else if (query?.warehouseId) where.warehouseId = Number(query.warehouseId);
    if (query?.objectId) where.objectId = Number(query.objectId);
    if (query?.from || query?.to) {
      where.createdAt = {
        ...(query?.from ? { gte: new Date(query.from) } : {}),
        ...(query?.to ? { lte: new Date(`${query.to}T23:59:59.999Z`) } : {}),
      };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.findMany({
        where,
        include: {
          item: true,
          supplier: { select: { id: true, name: true } },
          warehouse: { select: { id: true, name: true, code: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.inventoryMovement.count({ where }),
    ]);

    const performerIds = [...new Set(rows.map((r) => r.performedBy).filter((x): x is number => x != null))];
    const performers = await this.usersPrisma.getUsersByIds(performerIds);
    const nameOf = new Map(performers.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

    // #2042: object labels live in CRM — attach them when any row needs one.
    let objOf = new Map<number, string>();
    if (rows.some((r: any) => r.objectId != null)) {
      try {
        const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
        const res = await fetch(`${crmUrl}/api/construction-objects/internal/all`, {
          headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
        });
        if (res.ok) {
          const objects = (await res.json()) as { id: number; code: string; name: string }[];
          objOf = new Map(objects.map((o) => [o.id, `${o.code} — ${o.name}`]));
        }
      } catch {
        /* rows render with the bare id */
      }
    }

    return {
      data: rows.map((r: any) => ({
        ...r,
        performedByName: r.performedBy ? nameOf.get(r.performedBy) ?? null : null,
        objectLabel: r.objectId != null ? objOf.get(r.objectId) ?? `#${r.objectId}` : null,
      })),
      total,
      page,
      limit,
    };
  }
}
