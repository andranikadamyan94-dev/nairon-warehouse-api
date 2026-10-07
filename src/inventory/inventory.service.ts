import { roundQty } from '../common/quantity';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { StockAlertService } from '../common/notifications/stock-alert.service';
import { UsersPrismaService } from '../common/users-prisma.service';
import { ObjectsService } from '../objects/objects.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from '../common/notifications/notifications.service';

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
    private readonly objectsService: ObjectsService,
    @Optional() private readonly notifications?: WarehouseNotificationsService,
  ) {}

  private readonly logger = new Logger(InventoryService.name);

  /**
   * Phase 3 (2026-10-07): a manual stock movement on the main pool reaches the
   * main warehouse's responsible person — stock changed by hand, outside a
   * receipt, an issue or a transfer. Never the actor.
   */
  private async announceAdjusted(
    item: { id: number; name: string; unit?: string | null },
    dto: InventoryMovementDto,
    before: number,
    after: number,
    actorId: number | null,
  ) {
    try {
      if (!this.notifications) return;
      const main = await this.prisma.warehouse.findFirst({ where: { type: 'MAIN' }, select: { responsibleId: true, name: true } });
      if (!main?.responsibleId) return;
      const kind: Record<string, string> = {
        IN: 'մուտք', OUT: 'ելք', RESERVATION: 'ամրագրում', RELEASE: 'ազատում', ADJUSTMENT: 'ճշգրտում',
      };
      await this.notifications.sendToUsers([main.responsibleId], {
        type: WAREHOUSE_TYPES.stockAdjusted,
        actorId,
        title: 'Պաշարը փոփոխվել է ձեռքով',
        body: `«${item.name}»՝ ${kind[dto.type] ?? dto.type} ${dto.quantity}, մնացորդ ${before} → ${after}${dto.notes ? ` — ${dto.notes}` : ''}։`,
        path: '/movements',
        details: [
          { label: 'Ապրանք', value: item.name },
          { label: 'Շարժ', value: `${kind[dto.type] ?? dto.type} ${dto.quantity}` },
          { label: 'Մնացորդ', value: `${before} → ${after}` },
          ...(dto.notes ? [{ label: 'Նշում', value: dto.notes }] : []),
        ],
      });
    } catch (e: any) {
      this.logger.warn(`stock adjustment notification failed: ${e?.message ?? e}`);
    }
  }

  async createMovement(dto: InventoryMovementDto, actorId?: number) {
    const item = await this.prisma.item.findUnique({
      where: {
        id: dto.itemId,
      },
    });

    if (!item) {
      throw new NotFoundException('Ռեսուրսը չի գտնվել');
    }

    if (item.type !== ItemType.CONSUMABLE) {
      throw new BadRequestException(
        'Պաշարի շարժումները հնարավոր են միայն ծախսվող ռեսուրսների համար',
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

    newQuantity = roundQty(newQuantity);
    if (newQuantity < 0) {
      throw new BadRequestException('Պաշարը բավարար չէ');
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
    void this.announceAdjusted(item, dto, item.quantity, newQuantity, actorId ?? dto.performedBy ?? null);

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

    // #2042: object labels live in CRM — the shared 60s cache serves them.
    let objOf = new Map<number, string>();
    if (rows.some((r: any) => r.objectId != null)) {
      try {
        const objects = await this.objectsService.crmObjects();
        objOf = new Map(objects.map((o) => [o.id, `${o.code} — ${o.name}`]));
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
