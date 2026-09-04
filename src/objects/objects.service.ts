import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { ItemType } from '../common/enums/item-type.enum';

/**
 * #2042 — the warehouse side of construction objects: materials actually
 * issued (one ledger, object + task lenses), frozen costs, estimate lines and
 * the planned/actual comparison. Object identity lives in CRM; this module
 * reads it through the internal endpoint.
 */
@Injectable()
export class ObjectsService {
  constructor(private readonly prisma: PrismaService) {}

  // The object catalog changes rarely; a short cache keeps list/summary/
  // movements enrichment off CRM's back on every page load.
  private objectsCache: { at: number; data: any[] } | null = null;
  private static readonly OBJECTS_TTL_MS = 60_000;

  async crmObjects(): Promise<
    { id: number; code: string; name: string; backlogId: number; status: string; plannedCost: number | null }[]
  > {
    if (this.objectsCache && Date.now() - this.objectsCache.at < ObjectsService.OBJECTS_TTL_MS) {
      return this.objectsCache.data;
    }
    const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
    const res = await fetch(`${crmUrl}/api/construction-objects/internal/all`, {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
    });
    if (!res.ok) throw new BadRequestException('Օբյեկտների ցանկը հասանելի չէ (CRM)');
    const data = (await res.json()) as any[];
    this.objectsCache = { at: Date.now(), data };
    return data;
  }

  /** One object's catalog row. A freshly created object may postdate the
   *  cached catalog — a miss busts the cache and retries once, so a new
   *  object's summary is never served with null metadata for a TTL. */
  async crmObject(objectId: number) {
    let all = await this.crmObjects();
    let row = all.find((o) => o.id === objectId);
    if (!row && this.objectsCache) {
      this.objectsCache = null;
      all = await this.crmObjects();
      row = all.find((o) => o.id === objectId);
    }
    return row;
  }

  /** The CRM object list, for pickers/labels on the warehouse side. */
  list() {
    return this.crmObjects();
  }

  /** Cross-service delete guard: does the warehouse hold data for this object? */
  async usage(objectId: number) {
    const [movements, estimateLines] = await Promise.all([
      this.prisma.inventoryMovement.count({ where: { objectId } }),
      this.prisma.objectEstimateLine.count({ where: { objectId } }),
    ]);
    return { movements, estimateLines };
  }

  /** Ledger rows of one object (raw view, newest first, paginated). */
  async movements(objectId: number, query?: { page?: string; limit?: string }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.findMany({
        where: { objectId },
        include: {
          item: { select: { id: true, name: true, code: true, unit: true, category: { select: { name: true } } } },
          warehouse: { select: { id: true, name: true } },
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.inventoryMovement.count({ where: { objectId } }),
    ]);
    return { data: rows, total, page, limit };
  }

  /**
   * The Materials tab: per-item actuals — issued, returned, net quantity and
   * net value at frozen costs, with category/warehouse/task breadcrumbs from
   * the underlying rows.
   */
  async materials(objectId: number) {
    const rows = await this.prisma.inventoryMovement.findMany({
      where: { objectId },
      include: {
        item: { select: { id: true, name: true, code: true, unit: true, category: { select: { name: true } } } },
        warehouse: { select: { id: true, name: true } },
      },
      orderBy: { id: 'asc' },
    });
    const byItem = new Map<number, any>();
    for (const m of rows) {
      let agg = byItem.get(m.itemId);
      if (!agg) {
        agg = {
          itemId: m.itemId,
          itemName: m.item?.name ?? `#${m.itemId}`,
          itemCode: m.item?.code ?? null,
          unit: m.item?.unit ?? null,
          category: m.item?.category?.name ?? null,
          issuedQuantity: 0,
          returnedQuantity: 0,
          netQuantity: 0,
          netCost: 0,
          costKnown: true,
          warehouses: new Set<string>(),
          taskIds: new Set<number>(),
          lastMovementAt: m.createdAt,
        };
        byItem.set(m.itemId, agg);
      }
      const qty = Math.abs(m.quantity);
      if (m.type === 'OUT') {
        agg.issuedQuantity += qty;
        agg.netQuantity += qty;
        if (m.totalCost != null) agg.netCost += m.totalCost;
        else agg.costKnown = false;
      } else {
        agg.returnedQuantity += qty;
        agg.netQuantity -= qty;
        if (m.totalCost != null) agg.netCost -= m.totalCost;
        else agg.costKnown = false;
      }
      agg.warehouses.add(m.warehouse?.name ?? 'Հիմնական պահեստ');
      if (m.taskId) agg.taskIds.add(m.taskId);
      agg.lastMovementAt = m.createdAt;
    }
    return [...byItem.values()].map((a) => ({
      ...a,
      warehouses: [...a.warehouses],
      taskIds: [...a.taskIds],
      netCost: Math.round(a.netCost * 100) / 100,
    }));
  }

  /** Planned vs actual: object cost header + per-estimate-line deviations. */
  async summary(objectId: number) {
    const [object, materials, estimate] = await Promise.all([
      this.crmObject(objectId).then((o) => o ?? null).catch(() => null),
      this.materials(objectId),
      this.prisma.objectEstimateLine.findMany({
        where: { objectId },
        include: { item: { select: { id: true, name: true, unit: true } } },
        orderBy: { id: 'asc' },
      }),
    ]);
    const actualMaterialCost = Math.round(materials.reduce((s, m) => s + (m.netCost ?? 0), 0) * 100) / 100;
    const actualByItem = new Map(materials.map((m) => [m.itemId, m]));

    const lines = estimate.map((l) => {
      const actual = actualByItem.get(l.itemId);
      const actualQuantity = actual?.netQuantity ?? 0;
      const plannedTotal = l.plannedUnitCost != null ? l.plannedQuantity * l.plannedUnitCost : null;
      const actualTotal = actual?.netCost ?? 0;
      return {
        id: l.id,
        itemId: l.itemId,
        itemName: l.item?.name ?? `#${l.itemId}`,
        unit: l.item?.unit ?? null,
        note: l.note,
        plannedQuantity: l.plannedQuantity,
        plannedUnitCost: l.plannedUnitCost,
        plannedTotal,
        actualQuantity,
        actualTotal,
        quantityDeviation: actualQuantity - l.plannedQuantity,
        quantityDeviationPct:
          l.plannedQuantity > 0
            ? Math.round(((actualQuantity - l.plannedQuantity) / l.plannedQuantity) * 10000) / 100
            : null,
        costDeviation: plannedTotal != null ? Math.round((actualTotal - plannedTotal) * 100) / 100 : null,
      };
    });
    // materials issued outside the estimate belong in the comparison too
    const offPlan = materials
      .filter((m) => !estimate.some((l) => l.itemId === m.itemId))
      .map((m) => ({
        id: null,
        itemId: m.itemId,
        itemName: m.itemName,
        unit: m.unit,
        note: null,
        plannedQuantity: 0,
        plannedUnitCost: null,
        plannedTotal: null,
        actualQuantity: m.netQuantity,
        actualTotal: m.netCost,
        quantityDeviation: m.netQuantity,
        quantityDeviationPct: null,
        costDeviation: null,
      }));

    const plannedEstimateTotal = lines.reduce((s, l) => s + (l.plannedTotal ?? 0), 0);
    const plannedCost = object?.plannedCost ?? null;
    return {
      objectId,
      object,
      actualMaterialCost,
      plannedCost,
      plannedEstimateTotal: Math.round(plannedEstimateTotal * 100) / 100,
      costDeviation: plannedCost != null ? Math.round((actualMaterialCost - plannedCost) * 100) / 100 : null,
      costDeviationPct:
        plannedCost ? Math.round(((actualMaterialCost - plannedCost) / plannedCost) * 10000) / 100 : null,
      lines: [...lines, ...offPlan],
    };
  }

  listEstimate(objectId: number) {
    return this.prisma.objectEstimateLine.findMany({
      where: { objectId },
      include: { item: { select: { id: true, name: true, unit: true, type: true } } },
      orderBy: { id: 'asc' },
    });
  }

  async upsertEstimateLine(
    objectId: number,
    dto: { itemId: number; plannedQuantity: number; plannedUnitCost?: number | null; note?: string | null },
  ) {
    const qty = Number(dto.plannedQuantity);
    if (!(qty > 0)) throw new BadRequestException('Քանակը պետք է լինի դրական');
    const item = await this.prisma.item.findUnique({ where: { id: Number(dto.itemId) } });
    if (!item) throw new NotFoundException('Ապրանքը չի գտնվել');
    if (item.type !== ItemType.CONSUMABLE) {
      throw new BadRequestException('Նախահաշիվը ծախսվող նյութերի համար է');
    }
    return this.prisma.objectEstimateLine.upsert({
      where: { objectId_itemId: { objectId, itemId: item.id } },
      update: {
        plannedQuantity: qty,
        plannedUnitCost: dto.plannedUnitCost ?? null,
        note: dto.note?.trim() || null,
      },
      create: {
        objectId,
        itemId: item.id,
        plannedQuantity: qty,
        plannedUnitCost: dto.plannedUnitCost ?? null,
        note: dto.note?.trim() || null,
      },
      include: { item: { select: { id: true, name: true, unit: true } } },
    });
  }

  async removeEstimateLine(objectId: number, lineId: number) {
    const line = await this.prisma.objectEstimateLine.findUnique({ where: { id: lineId } });
    if (!line || line.objectId !== objectId) throw new NotFoundException('Տողը չի գտնվել');
    return this.prisma.objectEstimateLine.delete({ where: { id: lineId } });
  }
}
