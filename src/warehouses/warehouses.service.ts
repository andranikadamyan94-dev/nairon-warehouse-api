import { requireInternalSecret } from '../common/internal-headers';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { UsersPrismaService } from '../common/users-prisma.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from '../common/notifications/notifications.service';

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
    @Optional() private readonly notifications?: WarehouseNotificationsService,
  ) {}

  private readonly logger = new Logger(WarehousesService.name);

  /**
   * Phase 3 (2026-10-07): the people a warehouse change is about — made its
   * responsible person or no longer, added to or removed from its staff, or
   * everyone on it when it is closed / reopened. One notice per person, its
   * own wording; never the actor.
   */
  private announceAssignment(
    wh: { name: string; code: string },
    before: { responsibleId: number | null; staff: number[]; status: string } | null,
    after: { responsibleId: number | null; staff: number[]; status: string },
    actorId: number | null,
  ) {
    if (!this.notifications) return;
    const lines = new Map<number, string[]>();
    const say = (u: number | null | undefined, text: string) => {
      if (!u) return;
      lines.set(u, [...(lines.get(u) ?? []), text]);
    };
    const prevResp = before?.responsibleId ?? null;
    if (after.responsibleId !== prevResp) {
      say(after.responsibleId, 'դուք նշանակվել եք պահեստի պատասխանատու');
      say(prevResp, 'դուք այլևս պահեստի պատասխանատուն չեք');
    }
    const prevStaff = new Set(before?.staff ?? []);
    const nextStaff = new Set(after.staff);
    for (const u of nextStaff) if (!prevStaff.has(u)) say(u, 'դուք ավելացվել եք պահեստի աշխատակիցների մեջ');
    for (const u of prevStaff) if (!nextStaff.has(u)) say(u, 'դուք հանվել եք պահեստի աշխատակիցներից');
    if (before && before.status !== after.status) {
      const text = after.status === 'INACTIVE' ? 'պահեստը փակվել է (ապաակտիվացվել)' : 'պահեստը կրկին ակտիվ է';
      for (const u of new Set([after.responsibleId, ...after.staff])) if (u) say(u, text);
    }
    const label = `${wh.name} (${wh.code})`;
    for (const [userId, texts] of lines) {
      void this.notifications
        .sendToUsers([userId], {
          type: WAREHOUSE_TYPES.warehouseAssignment,
          actorId,
          title: 'Պահեստի նշանակման փոփոխություն',
          body: `${label}՝ ${texts.join('. ')}։`,
          path: '/warehouses',
          details: [{ label: 'Պահեստ', value: label }],
        })
        .catch((e: any) => this.logger.warn(`warehouse assignment notification failed: ${e?.message ?? e}`));
    }
  }

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

  /**
   * CRM project list for the «Կապված նախագծեր» picker (2026-09-29; the link
   * used to be per backlog). `parentId` lets the client show a sub-project's path.
   */
  async listProjects() {
    const res = await fetch(`${this.crmUrl()}/api/projects/internal`, {
      headers: { 'x-internal-secret': requireInternalSecret() },
    });
    if (!res.ok) {
      throw new BadRequestException('Նախագծերի ցանկը հասանելի չէ (CRM)');
    }
    const projects = (await res.json()) as { id: number; name: string; entityId: number | null; parentId?: number | null }[];
    const links = await this.prisma.warehouseProject.findMany({
      select: { projectId: true, warehouseId: true },
    });
    const linked = new Map(links.map((l) => [l.projectId, l.warehouseId]));
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      entityId: p.entityId ?? null,
      parentId: p.parentId ?? null,
      linkedWarehouseId: linked.get(p.id) ?? null,
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
          projects: true,
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

    // Prefer the LIVE project name over the link-time snapshot so CRM renames
    // show through; snapshots remain the fallback when CRM is down.
    let liveOf = new Map<number, { name: string }>();
    try {
      const projects = await this.listProjects();
      liveOf = new Map(projects.map((p) => [p.id, { name: p.name }]));
    } catch {
      /* names render from snapshots */
    }

    return {
      data: rows.map((w) => ({
        ...w,
        responsibleName: w.responsibleId ? nameOf.get(w.responsibleId) ?? null : null,
        employees: w.employees
          .filter((e) => activeIds.has(e.userId))
          .map((e) => ({ ...e, name: nameOf.get(e.userId) ?? null })),
        projects: w.projects.map((p) => ({
          ...p,
          projectName: liveOf.get(p.projectId)?.name ?? p.projectName,
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
      projectIds?: number[];
      employeeIds?: number[];
    },
    createdBy?: number,
  ) {
    const dup = await this.prisma.warehouse.findUnique({ where: { code: dto.code.trim() } });
    if (dup) throw new BadRequestException('Այս կոդով պահեստ արդեն կա');

    await this.assertProjectsLinkable(dto.projectIds ?? [], null);
    const projectNames = await this.projectNames(dto.projectIds ?? []);

    const created = await this.prisma.warehouse.create({
      data: {
        name: dto.name.trim(),
        code: dto.code.trim(),
        type: 'PROJECT',
        responsibleId: dto.responsibleId ?? null,
        location: dto.location?.trim() || null,
        createdBy: createdBy ?? null,
        projects: {
          create: (dto.projectIds ?? []).map((p) => ({
            projectId: p,
            projectName: projectNames.get(p) ?? `#${p}`,
          })),
        },
        employees: {
          create: [...new Set(dto.employeeIds ?? [])].map((userId) => ({ userId })),
        },
      },
      include: { projects: true, employees: true },
    });
    this.announceAssignment(
      created,
      null,
      { responsibleId: created.responsibleId, staff: created.employees.map((e) => e.userId), status: created.status },
      createdBy ?? null,
    );
    return created;
  }

  async update(
    id: number,
    dto: {
      name?: string;
      code?: string;
      responsibleId?: number | null;
      location?: string | null;
      status?: 'ACTIVE' | 'INACTIVE';
      projectIds?: number[];
      employeeIds?: number[];
    },
    actorId?: number,
  ) {
    const wh = await this.prisma.warehouse.findUnique({ where: { id }, include: { projects: true, employees: true } });
    if (!wh) throw new NotFoundException('Պահեստը չի գտնվել');
    // The main row's identity is fixed, but linking backlogs TO main is the
    // explicit way a «նախագիծ» opts into the main pool (unlinked = blocked).
    // Only an actual change is refused: the edit form sends every field it
    // shows, unchanged values included, so a key being present means nothing
    // (2026-09-11 — the main row's responsible/staff could not be saved).
    const mainIdentityChanged =
      (dto.name !== undefined && dto.name.trim() !== wh.name) ||
      (dto.code !== undefined && dto.code.trim() !== wh.code) ||
      (dto.status !== undefined && dto.status !== wh.status);
    if (wh.type === 'MAIN' && mainIdentityChanged) {
      throw new BadRequestException('Հիմնական պահեստի անվանումը, կոդը և կարգավիճակը խմբագրելի չեն');
    }
    if (dto.code && dto.code.trim() !== wh.code) {
      const dup = await this.prisma.warehouse.findUnique({ where: { code: dto.code.trim() } });
      if (dup) throw new BadRequestException('Այս կոդով պահեստ արդեն կա');
    }

    let projectOps: any;
    if (dto.projectIds) {
      await this.assertProjectsLinkable(dto.projectIds, id);
      const names = await this.projectNames(dto.projectIds);
      projectOps = {
        deleteMany: { projectId: { notIn: dto.projectIds } },
        upsert: dto.projectIds.map((p) => ({
          where: { projectId: p },
          update: { projectName: names.get(p) ?? `#${p}` },
          create: { projectId: p, projectName: names.get(p) ?? `#${p}` },
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

    const updated = await this.prisma.warehouse.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.code !== undefined ? { code: dto.code.trim() } : {}),
        ...(dto.responsibleId !== undefined ? { responsibleId: dto.responsibleId } : {}),
        ...(dto.location !== undefined ? { location: dto.location?.trim() || null } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(projectOps ? { projects: projectOps } : {}),
        ...(employeeOps ? { employees: employeeOps } : {}),
      },
      include: { projects: true, employees: true },
    });
    this.announceAssignment(
      updated,
      { responsibleId: wh.responsibleId, staff: (wh.employees ?? []).map((e) => e.userId), status: wh.status },
      { responsibleId: updated.responsibleId, staff: updated.employees.map((e) => e.userId), status: updated.status },
      actorId ?? null,
    );
    return updated;
  }

  /** One warehouse per project: reject links already owned by ANOTHER warehouse. */
  private async assertProjectsLinkable(projectIds: number[], selfId: number | null) {
    if (!projectIds.length) return;
    const taken = await this.prisma.warehouseProject.findMany({
      where: { projectId: { in: projectIds }, ...(selfId ? { warehouseId: { not: selfId } } : {}) },
    });
    if (taken.length) {
      throw new BadRequestException(
        `Նախագիծն արդեն կապված է այլ պահեստի հետ՝ ${taken.map((t) => t.projectName).join(', ')}`,
      );
    }
  }

  private async projectNames(projectIds: number[]): Promise<Map<number, string>> {
    if (!projectIds.length) return new Map();
    const all = await this.listProjects();
    return new Map(all.filter((p) => projectIds.includes(p.id)).map((p) => [p.id, p.name]));
  }
}
