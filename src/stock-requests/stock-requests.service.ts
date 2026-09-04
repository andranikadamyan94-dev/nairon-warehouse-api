import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { WarehousesService } from '../warehouses/warehouses.service';
import { StockTransfersService } from '../stock-transfers/stock-transfers.service';
import { UsersPrismaService } from '../common/users-prisma.service';

type Ctx = { isSuperAdmin?: boolean; permissionNames?: string[] };

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
  ) {}

  async create(
    dto: {
      warehouseId: number;
      items: { itemId: number; quantity: number }[];
      comment?: string;
    },
    userId: number,
    ctx?: Ctx,
  ) {
    const wh = await this.prisma.warehouse.findUnique({ where: { id: dto.warehouseId } });
    if (!wh) throw new NotFoundException('Պահեստը չի գտնվել');
    if (wh.type !== 'PROJECT') {
      throw new BadRequestException('Հայտ է ներկայացնում միայն նախագծային պահեստը');
    }
    if (wh.status !== 'ACTIVE') {
      throw new BadRequestException('Պահեստը ակտիվ չէ');
    }
    await this.warehousesService.assertWarehouseAccess(userId, wh.id, ctx);

    const lines = await this.validateLines(dto.items);

    return this.prisma.stockRequest.create({
      data: {
        warehouseId: wh.id,
        comment: dto.comment?.trim() || null,
        createdBy: userId,
        items: { create: lines },
      },
      include: { items: { include: { item: { select: { id: true, name: true, unit: true } } } } },
    });
  }

  private async validateLines(items: { itemId: number; quantity: number }[]) {
    const lines = (items ?? []).map((l) => ({ itemId: Number(l.itemId), quantity: Number(l.quantity) }));
    if (!lines.length) throw new BadRequestException('Ավելացրեք գոնե մեկ ապրանք');
    for (const l of lines) {
      if (!Number.isInteger(l.quantity) || l.quantity < 1) {
        throw new BadRequestException('Քանակը պետք է լինի ամբողջ դրական թիվ');
      }
    }
    if (new Set(lines.map((l) => l.itemId)).size !== lines.length) {
      throw new BadRequestException('Նույն ապրանքը կրկնվում է');
    }
    const found = await this.prisma.item.count({ where: { id: { in: lines.map((l) => l.itemId) } } });
    if (found !== lines.length) throw new NotFoundException('Ապրանքը չի գտնվել');
    return lines;
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
    } else {
      // The main-side queue: only transfer/warehouse staff may see everything.
      const names = ctx.permissionNames ?? [];
      const mainSide =
        ctx.isSuperAdmin ||
        names.includes('manage_stock_transfers') ||
        names.includes('manage_warehouses') ||
        names.includes('manage_warehouse');
      if (!mainSide) {
        const acc = await this.warehousesService.accessibleWarehouseIds(userId, ctx);
        if (acc !== 'all') where.warehouseId = { in: acc };
      }
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

    const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.decidedBy]).filter((x): x is number => x != null))];
    const users = await this.usersPrisma.getUsersByIds(ids);
    const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

    return {
      data: rows.map((r) => ({
        ...r,
        createdByName: r.createdBy ? nameOf.get(r.createdBy) ?? null : null,
        decidedByName: r.decidedBy ? nameOf.get(r.decidedBy) ?? null : null,
      })),
      total,
      page,
      limit,
    };
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
    return this.prisma.stockRequest.findUnique({ where: { id } });
  }

  /** The requester (or an admin) may withdraw a pending request. */
  async cancel(id: number, userId: number, isSuperAdmin: boolean) {
    const req = await this.prisma.stockRequest.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Հայտը չի գտնվել');
    if (req.status !== 'PENDING') {
      throw new BadRequestException('Հայտն արդեն որոշված է');
    }
    if (!isSuperAdmin && req.createdBy !== userId) {
      throw new ForbiddenException('Հայտը կարող է չեղարկել միայն ներկայացնողը');
    }
    const upd = await this.prisma.stockRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'CANCELLED', decidedBy: userId, decidedAt: new Date() },
    });
    if (upd.count === 0) throw new BadRequestException('Հայտն արդեն որոշված է');
    return this.prisma.stockRequest.findUnique({ where: { id } });
  }
}
