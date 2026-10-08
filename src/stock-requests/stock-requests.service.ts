import { roundQty } from '../common/quantity';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Optional,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { WarehousesService } from '../warehouses/warehouses.service';
import { StockTransfersService } from '../stock-transfers/stock-transfers.service';
import { UsersPrismaService } from '../common/users-prisma.service';
import { TxClient } from '../common/operations/operations.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService, warehouseLinks } from '../common/notifications/notifications.service';

type Ctx = { isSuperAdmin?: boolean; permissionNames?: string[] };

export type CreateStockRequestInput = {
  warehouseId: number;
  items: { itemId: number; quantity: number }[];
  comment?: string;
};

/**
 * Sub → main resource requests (#1989 wave 2): warehouse members file a
 * request for their sub; main staff (manage_stock_transfers) approve — which
 * executes a TO_SUB transfer atomically — or reject with a reason. The
 * requester can cancel while pending. Push transfers coexist: main can still
 * send stock unprompted.
 */
@Injectable()
export class StockRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly warehousesService: WarehousesService,
    private readonly stockTransfersService: StockTransfersService,
    private readonly usersPrisma: UsersPrismaService,
    @Optional() private readonly notifications?: WarehouseNotificationsService,
  ) {}

  // ── Notifications (phase 2, 2026-10-06) ──

  /**
   * Main hears of a sub's request: manage_stock_transfers / manage_warehouse
   * holders in the organisations whose stock is asked for (the lines' item
   * categories — a warehouse itself names no organisation). Called after the
   * write commits: by create() when it owns its write, by the controller after
   * runOnce otherwise.
   */
  announceCreated(
    req: { id: number; warehouseId: number; comment?: string | null; items?: { itemId: number; quantity: number; item?: { name: string; unit?: string | null } }[] },
    actorId: number,
  ) {
    if (!this.notifications) return;
    void (async () => {
      const [wh, entityIds] = await Promise.all([
        this.prisma.warehouse.findUnique({ where: { id: req.warehouseId }, select: { name: true } }),
        this.entitiesOfItems((req.items ?? []).map((l) => l.itemId)),
      ]);
      const lines = (req.items ?? []).map((l) => `${l.item?.name ?? `#${l.itemId}`} × ${l.quantity}`).join(', ');
      await this.notifications!.send({
        type: WAREHOUSE_TYPES.stockRequestCreated,
        permissions: ['manage_stock_transfers', 'manage_warehouse'],
        entityIds,
        actorId,
        title: 'Նոր հայտ նախագծային պահեստից',
        body: `${wh?.name ?? `Պահեստ #${req.warehouseId}`}՝ ${lines || 'ռեսուրսների հայտ'}`,
        path: warehouseLinks.stockRequest(req.id),
        details: [
          { label: 'Հայտ', value: `#${req.id}` },
          { label: 'Պահեստ', value: wh?.name ?? `#${req.warehouseId}` },
          ...(lines ? [{ label: 'Ապրանքներ', value: lines }] : []),
          ...(req.comment ? [{ label: 'Մեկնաբանություն', value: req.comment }] : []),
        ],
      });
    })().catch(() => undefined);
  }

  private async entitiesOfItems(itemIds: number[]): Promise<(number | null)[]> {
    if (!itemIds.length) return [null];
    const items = await this.prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { category: { select: { entityId: true } } },
    });
    const ids = [...new Set(items.map((i) => i.category?.entityId ?? null))];
    return ids.length ? ids : [null];
  }

  /** The requester hears main's answer. */
  private announceDecided(req: { id: number; createdBy: number | null; warehouseId: number }, actorId: number, approved: boolean, reason?: string) {
    if (!this.notifications || !req.createdBy) return;
    void this.notifications.sendToUsers([req.createdBy], {
      type: WAREHOUSE_TYPES.stockRequestDecided,
      actorId,
      title: approved ? 'Պահեստի հայտը հաստատվել է' : 'Պահեստի հայտը մերժվել է',
      body: approved
        ? `Հայտ #${req.id}՝ հիմնական պահեստը հաստատել է և ռեսուրսները փոխանցվել են։`
        : `Հայտ #${req.id}՝ հիմնական պահեստը մերժել է${reason ? `՝ ${reason}` : ''}։`,
      path: warehouseLinks.stockRequest(req.id),
      details: [
        { label: 'Հայտ', value: `#${req.id}` },
        ...(reason ? [{ label: 'Պատճառ', value: reason }] : []),
      ],
    });
  }

  /**
   * Everything create() checks before it writes: the warehouse exists, is a
   * PROJECT warehouse, is active, the caller belongs to it, and the lines hold.
   * Shared with previewCreate() so the preflight cannot drift from the mutation.
   */
  private async assertMayCreate(dto: CreateStockRequestInput, userId: number, ctx?: Ctx) {
    const wh = await this.prisma.warehouse.findUnique({ where: { id: dto.warehouseId } });
    if (!wh) throw new NotFoundException('Պահեստը չի գտնվել');
    if (wh.type !== 'PROJECT') {
      throw new BadRequestException('Հայտ է ներկայացնում միայն նախագծային պահեստը');
    }
    if (wh.status !== 'ACTIVE') {
      throw new BadRequestException('Պահեստը ակտիվ չէ');
    }
    await this.warehousesService.assertWarehouseAccess(userId, wh.id, ctx);

    const { lines, items } = await this.checkLines(dto.items);
    return { wh, lines, items };
  }

  /**
   * `tx` lets a caller run the write inside a transaction it also records its
   * own bookkeeping in — see OperationsService, which commits "this was filed"
   * together with the request itself. Absent, it is an ordinary call.
   */
  async create(dto: CreateStockRequestInput, userId: number, ctx?: Ctx, tx?: TxClient) {
    const { wh, lines } = await this.assertMayCreate(dto, userId, ctx);

    const created = await (tx ?? this.prisma).stockRequest.create({
      data: {
        warehouseId: wh.id,
        comment: dto.comment?.trim() || null,
        createdBy: userId,
        items: { create: lines },
      },
      include: { items: { include: { item: { select: { id: true, name: true, unit: true } } } } },
    });
    // Inside a caller's transaction nothing is committed yet — the caller announces.
    if (!tx) this.announceCreated(created, userId);
    return created;
  }

  /**
   * Preflight for create: the same checks, nothing written. Answers the
   * request as it would be filed — the warehouse and each line with the
   * catalogue's name and unit — for a confirmation card to show.
   * See src/common/preflight/preflight.ts: UX validation, never permission.
   */
  async previewCreate(dto: CreateStockRequestInput, userId: number, ctx?: Ctx) {
    const { wh, lines, items } = await this.assertMayCreate(dto, userId, ctx);
    const itemOf = new Map(items.map((i) => [i.id, i]));
    return {
      warehouse: { id: wh.id, name: wh.name, code: wh.code },
      comment: dto.comment?.trim() || null,
      items: lines.map((l) => ({
        itemId: l.itemId,
        itemName: itemOf.get(l.itemId)?.name ?? null,
        unit: itemOf.get(l.itemId)?.unit ?? null,
        quantity: l.quantity,
      })),
    };
  }

  private async validateLines(items: { itemId: number; quantity: number }[]) {
    return (await this.checkLines(items)).lines;
  }

  private async checkLines(items: { itemId: number; quantity: number }[]) {
    // Fractional since 2026-09-15 (three decimals); assets stay whole units.
    const lines = (items ?? []).map((l) => ({ itemId: Number(l.itemId), quantity: roundQty(Number(l.quantity)) }));
    if (!lines.length) throw new BadRequestException('Ավելացրեք գոնե մեկ ապրանք');
    for (const l of lines) {
      if (!(l.quantity > 0)) {
        throw new BadRequestException('Քանակը պետք է լինի դրական թիվ');
      }
    }
    if (new Set(lines.map((l) => l.itemId)).size !== lines.length) {
      throw new BadRequestException('Նույն ապրանքը կրկնվում է');
    }
    const found = await this.prisma.item.findMany({
      where: { id: { in: lines.map((l) => l.itemId) } },
      select: { id: true, type: true, name: true, unit: true },
    });
    if (found.length !== lines.length) throw new NotFoundException('Ապրանքը չի գտնվել');
    const assetIds = new Set(found.filter((i) => i.type === 'ASSET').map((i) => i.id));
    if (lines.some((l) => assetIds.has(l.itemId) && !Number.isInteger(l.quantity))) {
      throw new BadRequestException('Ակտիվների քանակը պետք է լինի ամբողջ թիվ');
    }
    return { lines, items: found };
  }

  /**
   * Edit a PENDING request's lines/comment. Allowed to the requester (fix
   * your own ask) and to main-side transfer staff (trim quantities to what
   * main can actually send before approving) — the same people approve() lets
   * decide, so this widens nothing.
   */
  async update(
    id: number,
    dto: { items?: { itemId: number; quantity: number }[]; comment?: string },
    userId: number,
    ctx?: Ctx,
  ) {
    const req = await this.prisma.stockRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Հայտը չի գտնվել');
    if (req.status !== 'PENDING') {
      throw new BadRequestException('Միայն սպասող հայտը կարող է խմբագրվել');
    }

    if (!ctx) {
      const info = await this.usersPrisma.getUserAccessInfo(userId);
      ctx = { isSuperAdmin: info.isSuperAdmin, permissionNames: info.permissionNames };
    }
    const names = ctx.permissionNames ?? [];
    const mainSide =
      ctx.isSuperAdmin ||
      names.includes('manage_stock_transfers') ||
      names.includes('manage_warehouses') ||
      names.includes('manage_warehouse');
    if (!mainSide && req.createdBy !== userId) {
      throw new ForbiddenException('Հայտը կարող է խմբագրել միայն ներկայացնողը');
    }

    const lines = dto.items !== undefined ? await this.validateLines(dto.items) : undefined;

    // Re-check status inside the transaction: an approve() racing this edit
    // has already executed the transfer, and rewriting the lines afterwards
    // would leave the request disagreeing with what was actually sent.
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.stockRequest.findUnique({ where: { id }, select: { status: true } });
      if (cur?.status !== 'PENDING') {
        throw new BadRequestException('Հայտի վիճակը փոխվել է — թարմացրեք էջը');
      }
      return tx.stockRequest.update({
        where: { id },
        data: {
          ...(dto.comment !== undefined ? { comment: dto.comment?.trim() || null } : {}),
          ...(lines ? { items: { deleteMany: {}, create: lines } } : {}),
        },
        include: {
          warehouse: { select: { id: true, name: true, code: true } },
          items: { include: { item: { select: { id: true, name: true, unit: true, type: true } } } },
        },
      });
    });
  }

  async findAll(
    query: { page?: string; limit?: string; warehouseId?: string; status?: string },
    userId: number,
    ctx?: Ctx,
  ) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    const where: any = {};
    if (query.status) where.status = query.status;

    // Routes here run without PermissionGuard (membership is the gate), so
    // resolve access info when the controller couldn't provide it.
    if (!ctx) {
      const info = await this.usersPrisma.getUserAccessInfo(userId);
      ctx = { isSuperAdmin: info.isSuperAdmin, permissionNames: info.permissionNames };
    }

    if (query.warehouseId) {
      const whId = Number(query.warehouseId);
      await this.warehousesService.assertWarehouseAccess(userId, whId, ctx);
      where.warehouseId = whId;
    } else if (!this.isMainSide(ctx)) {
      const acc = await this.warehousesService.accessibleWarehouseIds(userId, ctx);
      if (acc !== 'all') where.warehouseId = { in: acc };
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.stockRequest.findMany({
        where,
        include: {
          warehouse: { select: { id: true, name: true, code: true } },
          items: { include: { item: { select: { id: true, name: true, unit: true, type: true } } } },
        },
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.stockRequest.count({ where }),
    ]);

    return {
      data: await this.withNames(rows),
      total,
      page,
      limit,
    };
  }

  /**
   * One request, by the list's own rule (notification deep links,
   * 2026-10-08): main-side staff read any; anybody else only a request of a
   * warehouse they belong to — 404 otherwise, so an id says nothing about
   * requests the person may not see.
   */
  async findOne(id: number, userId: number, ctx?: Ctx) {
    if (!ctx) {
      const info = await this.usersPrisma.getUserAccessInfo(userId);
      ctx = { isSuperAdmin: info.isSuperAdmin, permissionNames: info.permissionNames };
    }
    const row = await this.prisma.stockRequest.findUnique({
      where: { id },
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
        items: { include: { item: { select: { id: true, name: true, unit: true, type: true } } } },
      },
    });
    if (!row) throw new NotFoundException('Հայտը չի գտնվել');
    if (!this.isMainSide(ctx)) {
      const acc = await this.warehousesService.accessibleWarehouseIds(userId, ctx);
      if (acc !== 'all' && !acc.includes(row.warehouseId)) throw new NotFoundException('Հայտը չի գտնվել');
    }
    return (await this.withNames([row]))[0];
  }

  /** The main-side queue: only transfer/warehouse staff may see everything. */
  private isMainSide(ctx: Ctx): boolean {
    const names = ctx.permissionNames ?? [];
    return (
      !!ctx.isSuperAdmin ||
      names.includes('manage_stock_transfers') ||
      names.includes('manage_warehouses') ||
      names.includes('manage_warehouse')
    );
  }

  /** Creator's and decider's names next to their ids. */
  private async withNames<T extends { createdBy: number | null; decidedBy: number | null }>(rows: T[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.decidedBy]).filter((x): x is number => x != null))];
    const users = await this.usersPrisma.getUsersByIds(ids);
    const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return rows.map((r) => ({
      ...r,
      createdByName: r.createdBy ? nameOf.get(r.createdBy) ?? null : null,
      decidedByName: r.decidedBy ? nameOf.get(r.decidedBy) ?? null : null,
    }));
  }

  /** Approve = execute the TO_SUB transfer atomically, then mark the request. */
  async approve(id: number, userId: number) {
    const req = await this.prisma.stockRequest.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!req) throw new NotFoundException('Հայտը չի գտնվել');
    if (req.status !== 'PENDING') {
      throw new BadRequestException('Հայտն արդեն որոշված է');
    }

    const transfer = await this.stockTransfersService.create(
      {
        toWarehouseId: req.warehouseId,
        direction: 'TO_SUB',
        items: req.items.map((l) => ({ itemId: l.itemId, quantity: l.quantity })),
        comment: `Հայտ #${req.id}${req.comment ? ` — ${req.comment}` : ''}`,
      },
      userId,
      // The requester hears «approved» below; the sub's responsible hears the
      // incoming transfer — unless that is the same person.
      { notifyExclude: req.createdBy ? [req.createdBy] : [] },
    );

    // The transfer succeeded; a lost update here would strand an approved
    // request as PENDING, so guard on status for idempotency.
    const upd = await this.prisma.stockRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'APPROVED', decidedBy: userId, decidedAt: new Date(), transferId: transfer!.id },
    });
    if (upd.count === 0) {
      throw new BadRequestException('Հայտի վիճակը փոխվել է — ստուգեք փոխանցումների պատմությունը');
    }
    this.announceDecided(req, userId, true);
    return { ...req, status: 'APPROVED', transferId: transfer!.id };
  }

  async reject(id: number, userId: number, reason?: string) {
    if (!reason?.trim()) {
      throw new BadRequestException('Մերժման պատճառը պարտադիր է');
    }
    const upd = await this.prisma.stockRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', rejectionReason: reason.trim(), decidedBy: userId, decidedAt: new Date() },
    });
    if (upd.count === 0) {
      throw new BadRequestException('Հայտը չի գտնվել կամ արդեն որոշված է');
    }
    const row = await this.prisma.stockRequest.findUnique({ where: { id } });
    if (row) this.announceDecided(row, userId, false, reason.trim());
    return row;
  }

  /** What cancel() checks before it writes. Shared with the assistant's preflight. */
  private async cancellable(id: number, userId: number, isSuperAdmin: boolean) {
    const req = await this.prisma.stockRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Հայտը չի գտնվել');
    if (req.status !== 'PENDING') {
      throw new BadRequestException('Հայտն արդեն որոշված է');
    }
    if (!isSuperAdmin && req.createdBy !== userId) {
      throw new ForbiddenException('Հայտը կարող է չեղարկել միայն ներկայացնողը');
    }
    return req;
  }

  /** The requester (or an admin) may withdraw a pending request. */
  async cancel(id: number, userId: number, isSuperAdmin: boolean) {
    const req = await this.cancellable(id, userId, isSuperAdmin);
    const upd = await this.prisma.stockRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', decidedBy: userId, decidedAt: new Date() },
    });
    if (upd.count === 0) throw new BadRequestException('Հայտն արդեն որոշված է');
    this.announceCancelled(req, userId);
    return this.prisma.stockRequest.findUnique({ where: { id } });
  }

  /**
   * Phase 3 (2026-10-07): main stops waiting on a withdrawn request — the
   * audience its creation reached; the requester too when an admin withdrew it.
   */
  private announceCancelled(req: { id: number; warehouseId: number; createdBy: number | null }, actorId: number) {
    if (!this.notifications) return;
    void (async () => {
      const [wh, lines] = await Promise.all([
        this.prisma.warehouse.findUnique({ where: { id: req.warehouseId }, select: { name: true } }),
        this.prisma.stockRequestItem.findMany({ where: { requestId: req.id }, include: { item: { select: { name: true } } } }),
      ]);
      const entityIds = await this.entitiesOfItems(lines.map((l: any) => l.itemId));
      const what = lines.map((l: any) => `${l.item?.name ?? `#${l.itemId}`} × ${l.quantity}`).join(', ');
      await this.notifications!.send({
        type: WAREHOUSE_TYPES.stockRequestCancelled,
        permissions: ['manage_stock_transfers', 'manage_warehouse'],
        entityIds,
        userIds: [req.createdBy],
        actorId,
        title: 'Պահեստի հայտը չեղարկվել է',
        body: `Հայտ #${req.id}՝ ${wh?.name ?? `Պահեստ #${req.warehouseId}`}${what ? ` (${what})` : ''} — չեղարկվել է։`,
        path: warehouseLinks.stockRequest(req.id),
        details: [
          { label: 'Հայտ', value: `#${req.id}` },
          { label: 'Պահեստ', value: wh?.name ?? `#${req.warehouseId}` },
        ],
      });
    })().catch(() => undefined);
  }

  /**
   * The assistant's preflight for «Չեղարկել» (2026-10-01, coverage gaps batch
   * 4): cancel()'s own check, nothing written, and one rule more — the owner's
   * for AI writes: only the person who filed the request withdraws it here
   * (an administrator withdrawing somebody else's stays on the screen).
   * Answers the request as the card shows it, and `material` — what an
   * agreement is pinned to. A request has no updatedAt, so its lines and
   * comment are the pin: an edit in between supersedes the card.
   */
  async previewCancel(id: number, userId: number) {
    const req = await this.cancellable(id, userId, false);
    const full = await this.prisma.stockRequest.findUnique({
      where: { id: req.id },
      include: {
        warehouse: { select: { id: true, name: true, code: true } },
        items: { include: { item: { select: { id: true, name: true, unit: true } } }, orderBy: { id: 'asc' } },
      },
    });
    if (!full) throw new NotFoundException('Հայտը չի գտնվել');
    const lines = full.items.map((l) => ({ itemId: l.itemId, itemName: l.item?.name ?? null, unit: l.item?.unit ?? null, quantity: l.quantity }));
    return {
      from: full.status,
      to: 'CANCELLED' as const,
      request: {
        id: full.id,
        warehouse: full.warehouse,
        comment: full.comment,
        createdAt: full.createdAt.toISOString(),
        items: lines,
        material: {
          requestId: full.id,
          status: full.status,
          createdBy: full.createdBy,
          warehouseId: full.warehouseId,
          comment: full.comment,
          lines: lines.map((l) => [l.itemId, l.quantity]),
        },
      },
    };
  }
}
