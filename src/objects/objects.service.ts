import { requireInternalSecret } from '../common/internal-headers';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { ItemType } from '../common/enums/item-type.enum';

export type CrmObjectCard = {
  id: number; code: string; name: string; projectId: number | null; projectName: string | null; entityId: number | null; responsibleId: number | null;
};

/**
 * One object's card as CRM's internal route answers it — never from the
 * catalogue cache: for decisions (who is responsible), not labels. A missing
 * object is a 404; CRM unreachable is a 400 the caller may retry. The one
 * lookup behind ObjectsService.card and ReservationsService.objectCard.
 */
export async function fetchCrmObjectCard(objectId: number): Promise<CrmObjectCard> {
  const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
  let res: Response;
  try {
    res = await fetch(`${crmUrl}/api/construction-objects/internal/${objectId}/card`, {
      headers: { 'x-internal-secret': requireInternalSecret() },
    });
  } catch {
    throw new BadRequestException('Օբյեկտի տվյալները հասանելի չեն (CRM) — փորձեք կրկին');
  }
  if (res.status === 404) throw new NotFoundException('Օբյեկտը չի գտնվել');
  if (!res.ok) throw new BadRequestException('Օբյեկտի տվյալները հասանելի չեն (CRM) — փորձեք կրկին');
  return (await res.json()) as CrmObjectCard;
}

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
    { id: number; code: string; name: string; projectId: number | null; entityId: number | null; status: string; plannedCost: number | null; responsibleId?: number | null }[]
  > {
    if (this.objectsCache && Date.now() - this.objectsCache.at < ObjectsService.OBJECTS_TTL_MS) {
      return this.objectsCache.data;
    }
    const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
    const res = await fetch(`${crmUrl}/api/construction-objects/internal/all`, {
      headers: { 'x-internal-secret': requireInternalSecret() },
    });
    if (!res.ok) throw new BadRequestException('Օբյեկտների ցանկը հասանելի չէ (CRM)');
    const data = (await res.json()) as any[];
    this.objectsCache = { at: Date.now(), data };
    return data;
  }

  /** One object's catalog row. A freshly created object may postdate the
   *  cached catalog — a miss busts the cache and retries once, so a new
   *  object's summary is never served with null metadata for a TTL. */
  /** The same row, read past the cache — for decisions (who may act), not labels. */
  async crmObjectFresh(objectId: number) {
    this.objectsCache = null;
    return this.crmObject(objectId);
  }

  /** The whole list past the cache — for a picker that must show an object made a moment ago (catalog, 2026-10-08). */
  async crmObjectsFresh() {
    this.objectsCache = null;
    return this.crmObjects();
  }

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

  /** One object's card, fresh from CRM (fetchCrmObjectCard) — for decisions, not labels. */
  card(objectId: number): Promise<CrmObjectCard> {
    return fetchCrmObjectCard(objectId);
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

  /**
   * CRM attaches this object to a project (2026-09-29). Everything stamped
   * with the project's automatic object (`fromObjectId`) moves here —
   * movements, reservations, estimate lines, asset holds — and the project's
   * own tasks' movements/reservations that were never stamped are stamped now.
   * Rows stamped with some other object stay as they are (an explicit choice).
   * Refused when both objects have estimate lines (they cannot be merged).
   */
  async adopt(objectId: number, body: { fromObjectId?: number | null; taskIds?: number[] }) {
    const from = body?.fromObjectId ? Number(body.fromObjectId) : null;
    const ids = (body?.taskIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (from) {
      const [mine, theirs] = await Promise.all([
        this.prisma.objectEstimateLine.count({ where: { objectId } }),
        this.prisma.objectEstimateLine.count({ where: { objectId: from } }),
      ]);
      if (mine && theirs) throw new BadRequestException('Երկու օբյեկտներն էլ ունեն նախահաշիվ․ միավորել հնարավոր չէ');
    }
    const cond: any[] = [...(from ? [{ objectId: from }] : []), ...(ids.length ? [{ objectId: null, taskId: { in: ids } }] : [])];
    const result = await this.prisma.$transaction(async (tx) => {
      const movements = cond.length ? (await tx.inventoryMovement.updateMany({ where: { OR: cond }, data: { objectId } })).count : 0;
      const reservations = cond.length ? (await tx.resourceReservation.updateMany({ where: { OR: cond }, data: { objectId } })).count : 0;
      let estimateLines = 0, custody = 0;
      if (from) {
        estimateLines = (await tx.objectEstimateLine.updateMany({ where: { objectId: from }, data: { objectId } })).count;
        custody += (await tx.assetCustody.updateMany({ where: { holderObjectId: from }, data: { holderObjectId: objectId } })).count;
        custody += (await tx.assetCustody.updateMany({ where: { originObjectId: from }, data: { originObjectId: objectId } })).count;
      }
      return { movements, reservations, estimateLines, custody };
    });
    this.taskIdsCache.delete(objectId);
    if (from) this.taskIdsCache.delete(from);
    return result;
  }

  private taskIdsCache = new Map<number, { at: number; ids: number[] }>();

  /**
   * The movements that belong to an object (2026-09-29): those stamped with it
   * at issue time, and every movement of the tasks its costs follow — its
   * project's and sub-projects' tasks (CRM decides, cached a minute). History
   * from before the object existed counts too. CRM unreachable → stamped only.
   */
  private async scopeOf(objectId: number): Promise<any> {
    const hit = this.taskIdsCache.get(objectId);
    let ids = hit && Date.now() - hit.at < 60_000 ? hit.ids : null;
    if (!ids) {
      try {
        const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
        const res = await fetch(`${crmUrl}/api/construction-objects/internal/${objectId}/task-ids`, {
          headers: { 'x-internal-secret': requireInternalSecret() },
        });
        ids = res.ok ? (((await res.json()) as any)?.taskIds ?? []) : [];
      } catch {
        ids = [];
      }
      this.taskIdsCache.set(objectId, { at: Date.now(), ids: ids ?? [] });
    }
    return ids && ids.length ? { OR: [{ objectId }, { taskId: { in: ids }, type: { in: ['OUT', 'IN'] } }] } : { objectId };
  }

  /**
   * Net material cost of many objects in one pass (2026-09-29, the CRM objects
   * tree). CRM sends each object with the tasks its costs follow; the same rule
   * as the object page applies: rows stamped with the object, plus OUT/IN rows
   * of those tasks. Issues add, everything else (returns) subtracts, at frozen
   * costs — exactly what the Materials tab totals.
   */
  async materialCosts(groups: { objectId: number; taskIds?: number[] }[]) {
    const list = (Array.isArray(groups) ? groups : [])
      .map((g) => ({ objectId: Number(g?.objectId), taskIds: (Array.isArray(g?.taskIds) ? g.taskIds : []).map(Number).filter(Number.isInteger) }))
      .filter((g) => Number.isInteger(g.objectId) && g.objectId > 0);
    const costs: Record<number, number> = {};
    if (!list.length) return { costs };
    const objectIds = [...new Set(list.map((g) => g.objectId))];
    const taskIds = [...new Set(list.flatMap((g) => g.taskIds))];
    const select = { id: true, objectId: true, taskId: true, type: true, totalCost: true } as const;
    const byId = new Map<number, { objectId: number | null; taskId: number | null; type: string; totalCost: number | null }>();
    const take = (rows: any[]) => rows.forEach((r) => byId.set(r.id, r));
    take(await this.prisma.inventoryMovement.findMany({ where: { objectId: { in: objectIds } }, select }));
    for (let i = 0; i < taskIds.length; i += 10000) {
      take(await this.prisma.inventoryMovement.findMany({ where: { taskId: { in: taskIds.slice(i, i + 10000) }, type: { in: ['OUT', 'IN'] } }, select }));
    }
    const rows = [...byId.values()];
    for (const g of list) {
      const tasks = new Set(g.taskIds);
      let sum = 0;
      for (const r of rows) {
        const mine = r.objectId === g.objectId || (r.taskId != null && tasks.has(r.taskId) && (r.type === 'OUT' || r.type === 'IN'));
        if (!mine || r.totalCost == null) continue;
        sum += r.type === 'OUT' ? r.totalCost : -r.totalCost;
      }
      costs[g.objectId] = Math.round(sum * 100) / 100;
    }
    return { costs };
  }

  /** Ledger rows of one object (raw view, newest first, paginated). */
  async movements(objectId: number, query?: { page?: string; limit?: string }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);
    const scope = await this.scopeOf(objectId);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.inventoryMovement.findMany({
        where: scope,
        include: {
          item: { select: { id: true, name: true, code: true, unit: true, category: { select: { name: true } } } },
          warehouse: { select: { id: true, name: true } },
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.inventoryMovement.count({ where: scope }),
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
      where: await this.scopeOf(objectId),
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
