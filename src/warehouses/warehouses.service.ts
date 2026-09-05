import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { UsersPrismaService } from '../common/users-prisma.service';

/**
 * #1989 sub-warehouses. The MAIN row is identity only — its stock is
 * Item.quantity and it is not editable/creatable here; PROJECT warehouses hold
 * WarehouseStock and are replenished only by transfer from main. A CRM backlog
 * («նախագիծ» in the team's language) links to at most one warehouse.
 */
@Injectable()
export class WarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersPrisma: UsersPrismaService,
  ) {}

  private crmUrl() {
    return process.env.CRM_API_URL || 'http://localhost:3003';
  }

  /**
   * Membership scoping (#1989 wave 2). 'all' for superadmins and warehouse
   * admins; otherwise the warehouses the user belongs to (employee or
   * responsible) — plus MAIN, which stays open to everyone with page access
   * until main membership is deliberately enforced (rollout safety).
   */
  async accessibleWarehouseIds(
    userId: number,
    ctx?: { isSuperAdmin?: boolean; permissionNames?: string[] },
  ): Promise<'all' | number[]> {
    if (!ctx || (ctx.isSuperAdmin === undefined && !ctx.permissionNames)) {
      // Route without PermissionGuard (e.g. /warehouses/mine) — resolve here.
      const info = await this.usersPrisma.getUserAccessInfo(userId);
      ctx = { isSuperAdmin: info.isSuperAdmin, permissionNames: info.permissionNames };
    }
    if (
      ctx?.isSuperAdmin ||
      ctx?.permissionNames?.includes('manage_warehouses') ||
      ctx?.permissionNames?.includes('manage_warehouse')
    ) {
      return 'all';
    }
    const [memberships, owned, main] = await Promise.all([
      this.prisma.warehouseEmployee.findMany({ where: { userId }, select: { warehouseId: true } }),
      this.prisma.warehouse.findMany({ where: { responsibleId: userId }, select: { id: true } }),
      this.prisma.warehouse.findFirst({ where: { type: 'MAIN' }, select: { id: true } }),
    ]);
    return [
      ...new Set([
        ...(main ? [main.id] : []),
        ...memberships.map((m) => m.warehouseId),
        ...owned.map((w) => w.id),
      ]),
    ];
  }

  /** Refuse warehouseId params outside the caller's scope ('main' is open). */
  async assertWarehouseAccess(
    userId: number,
    warehouseId: number,
    ctx?: { isSuperAdmin?: boolean; permissionNames?: string[] },
  ): Promise<void> {
    const acc = await this.accessibleWarehouseIds(userId, ctx);
    if (acc === 'all' || acc.includes(warehouseId)) return;
    throw new ForbiddenException('Դուք այս պահեստի աշխատակից չեք');
  }

  /** The switcher's list: warehouses this user can enter (ACTIVE only). */
  async findMine(userId: number, ctx?: { isSuperAdmin?: boolean; permissionNames?: string[] }) {
    const acc = await this.accessibleWarehouseIds(userId, ctx);
    return this.prisma.warehouse.findMany({
      where: {
        status: 'ACTIVE',
        ...(acc === 'all' ? {} : { id: { in: acc } }),
      },
      select: { id: true, name: true, code: true, type: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    });
  }

  /** CRM backlog list for the «Կապված նախագիծ» picker. */
  async listBacklogs() {
    const res = await fetch(`${this.crmUrl()}/api/backlogs/internal/all`, {
      headers: { 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
    });
    if (!res.ok) {
      throw new BadRequestException('Նախագծերի ցանկը հասանելի չէ (CRM)');
    }
    const backlogs = (await res.json()) as {
      id: number; name: string; isDefault: boolean; projectId: number;
      project?: { name?: string };
    }[];
    const links = await this.prisma.warehouseBacklog.findMany({
      select: { backlogId: true, warehouseId: true },
    });
    const linked = new Map(links.map((l) => [l.backlogId, l.warehouseId]));
    return backlogs.map((b) => ({
      id: b.id,
      name: b.name,
      isDefault: b.isDefault,
      projectId: b.projectId,
      projectName: b.project?.name ?? null,
      linkedWarehouseId: linked.get(b.id) ?? null,
    }));
  }

  async findAll(query?: { page?: string; limit?: string; search?: string; status?: string }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);
    const where: any = {};
    if (query?.status) where.status = query.status;
    if (query?.search) {
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { code: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.warehouse.findMany({
        where,
        include: {
          backlogs: true,
          employees: true,
          _count: { select: { stock: true, transfersIn: true } },
        },
        orderBy: [{ type: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    const respIds = [
      ...new Set([
        ...rows.map((w) => w.responsibleId).filter((x): x is number => x != null),
        ...rows.flatMap((w) => w.employees.map((e) => e.userId)),
      ]),
    ];
    const users = await this.usersPrisma.getUsersByIds(respIds);
    const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    // Rosters describe who works a warehouse TODAY — departed people drop out
    // of the display (and out of the row on the next roster save, since the
    // edit form round-trips this list). The responsible NAME stays even when
    // deactivated: a blank there would hide that a replacement is needed.
    const activeIds = new Set(
      await this.usersPrisma.filterActive(rows.flatMap((w) => w.employees.map((e) => e.userId))),
    );

    // A client's backlog exists once per project, so links often share a name
    // (six «Սյունար» tags) — attach the project name live for disambiguation,
    // and prefer the LIVE backlog name over the link-time snapshot so CRM
    // renames show through; snapshots remain the fallback when CRM is down.
    let liveOf = new Map<number, { name: string; projectName: string | null }>();
    try {
      const backlogs = await this.listBacklogs();
      liveOf = new Map(backlogs.map((b) => [b.id, { name: b.name, projectName: b.projectName }]));
    } catch {
      /* names render from snapshots, without the suffix */
    }

    return {
      data: rows.map((w) => ({
        ...w,
        responsibleName: w.responsibleId ? nameOf.get(w.responsibleId) ?? null : null,
        employees: w.employees
          .filter((e) => activeIds.has(e.userId))
          .map((e) => ({ ...e, name: nameOf.get(e.userId) ?? null })),
        backlogs: w.backlogs.map((b) => ({
          ...b,
          backlogName: liveOf.get(b.backlogId)?.name ?? b.backlogName,
          projectName: liveOf.get(b.backlogId)?.projectName ?? null,
        })),
      })),
      total,
      page,
      limit,
    };
  }

  /** Stock of one warehouse (project warehouses only — main is the items page). */
  async getStock(id: number) {
    const wh = await this.prisma.warehouse.findUnique({ where: { id } });
    if (!wh) throw new NotFoundException('Պահեստը չի գտնվել');
    if (wh.type === 'MAIN') {
      throw new BadRequestException('Հիմնական պահեստի պաշարը Ռեսուրսներ էջում է');
    }
    return this.prisma.warehouseStock.findMany({
      where: { warehouseId: id, quantity: { gt: 0 } },
      include: { item: { select: { id: true, name: true, code: true, unit: true, type: true } } },
      orderBy: { itemId: 'asc' },
    });
  }

  async create(
    dto: {
      name: string;
      code: string;
      responsibleId?: number;
      location?: string;
      backlogIds?: number[];
      employeeIds?: number[];
    },
    createdBy?: number,
  ) {
    if (!dto.name?.trim() || !dto.code?.trim()) {
      throw new BadRequestException('Անվանումը և կոդը պարտադիր են');
    }
    const dup = await this.prisma.warehouse.findUnique({ where: { code: dto.code.trim() } });
    if (dup) throw new BadRequestException('Այս կոդով պահեստ արդեն կա');

    await this.assertBacklogsLinkable(dto.backlogIds ?? [], null);
    const backlogNames = await this.backlogNames(dto.backlogIds ?? []);

    return this.prisma.warehouse.create({
      data: {
        name: dto.name.trim(),
        code: dto.code.trim(),
        type: 'PROJECT',
        responsibleId: dto.responsibleId ?? null,
        location: dto.location?.trim() || null,
        createdBy: createdBy ?? null,
        backlogs: {
          create: (dto.backlogIds ?? []).map((b) => ({
            backlogId: b,
            backlogName: backlogNames.get(b) ?? `#${b}`,
          })),
        },
        employees: {
          create: [...new Set(dto.employeeIds ?? [])].map((userId) => ({ userId })),
        },
      },
      include: { backlogs: true, employees: true },
    });
  }

  async update(
    id: number,
    dto: {
      name?: string;
      code?: string;
      responsibleId?: number | null;
      location?: string | null;
      status?: 'ACTIVE' | 'INACTIVE';
      backlogIds?: number[];
      employeeIds?: number[];
    },
  ) {
    const wh = await this.prisma.warehouse.findUnique({ where: { id }, include: { backlogs: true } });
    if (!wh) throw new NotFoundException('Պահեստը չի գտնվել');
    // The main row's identity is fixed, but linking backlogs TO main is the
    // explicit way a «նախագիծ» opts into the main pool (unlinked = blocked).
    if (wh.type === 'MAIN' && (dto.name !== undefined || dto.code !== undefined || dto.status !== undefined)) {
      throw new BadRequestException('Հիմնական պահեստի անվանումը, կոդը և կարգավիճակը խմբագրելի չեն');
    }
    if (dto.code && dto.code.trim() !== wh.code) {
      const dup = await this.prisma.warehouse.findUnique({ where: { code: dto.code.trim() } });
      if (dup) throw new BadRequestException('Այս կոդով պահեստ արդեն կա');
    }

    let backlogOps: any;
    if (dto.backlogIds) {
      await this.assertBacklogsLinkable(dto.backlogIds, id);
      const names = await this.backlogNames(dto.backlogIds);
      backlogOps = {
        deleteMany: { backlogId: { notIn: dto.backlogIds } },
        upsert: dto.backlogIds.map((b) => ({
          where: { backlogId: b },
          update: { backlogName: names.get(b) ?? `#${b}` },
          create: { backlogId: b, backlogName: names.get(b) ?? `#${b}` },
        })),
      };
    }

    let employeeOps: any;
    if (dto.employeeIds) {
      const ids = [...new Set(dto.employeeIds)];
      employeeOps = {
        deleteMany: { userId: { notIn: ids } },
        upsert: ids.map((userId) => ({
          where: { warehouseId_userId: { warehouseId: id, userId } },
          update: {},
          create: { userId },
        })),
      };
    }

    return this.prisma.warehouse.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.code !== undefined ? { code: dto.code.trim() } : {}),
        ...(dto.responsibleId !== undefined ? { responsibleId: dto.responsibleId } : {}),
        ...(dto.location !== undefined ? { location: dto.location?.trim() || null } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(backlogOps ? { backlogs: backlogOps } : {}),
        ...(employeeOps ? { employees: employeeOps } : {}),
      },
      include: { backlogs: true, employees: true },
    });
  }

  /** One warehouse per backlog: reject links already owned by ANOTHER warehouse. */
  private async assertBacklogsLinkable(backlogIds: number[], selfId: number | null) {
    if (!backlogIds.length) return;
    const taken = await this.prisma.warehouseBacklog.findMany({
      where: { backlogId: { in: backlogIds }, ...(selfId ? { warehouseId: { not: selfId } } : {}) },
    });
    if (taken.length) {
      throw new BadRequestException(
        `Նախագիծն արդեն կապված է այլ պահեստի հետ՝ ${taken.map((t) => t.backlogName).join(', ')}`,
      );
    }
  }

  private async backlogNames(backlogIds: number[]): Promise<Map<number, string>> {
    if (!backlogIds.length) return new Map();
    const all = await this.listBacklogs();
    return new Map(all.filter((b) => backlogIds.includes(b.id)).map((b) => [b.id, b.name]));
  }
}
