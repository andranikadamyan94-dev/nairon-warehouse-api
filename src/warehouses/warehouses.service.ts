import {
  BadRequestException,
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
          _count: { select: { stock: true, transfersIn: true } },
        },
        orderBy: [{ type: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.warehouse.count({ where }),
    ]);

    const respIds = [...new Set(rows.map((w) => w.responsibleId).filter((x): x is number => x != null))];
    const users = await this.usersPrisma.getUsersByIds(respIds);
    const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));

    // A client's backlog exists once per project, so links often share a name
    // (six «Սյունար» tags) — attach the project name live for disambiguation;
    // plain snapshots remain the fallback when CRM is unreachable.
    let projectOf = new Map<number, string | null>();
    try {
      const backlogs = await this.listBacklogs();
      projectOf = new Map(backlogs.map((b) => [b.id, b.projectName]));
    } catch {
      /* names render without the suffix */
    }

    return {
      data: rows.map((w) => ({
        ...w,
        responsibleName: w.responsibleId ? nameOf.get(w.responsibleId) ?? null : null,
        backlogs: w.backlogs.map((b) => ({ ...b, projectName: projectOf.get(b.backlogId) ?? null })),
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
      },
      include: { backlogs: true },
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

    return this.prisma.warehouse.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.code !== undefined ? { code: dto.code.trim() } : {}),
        ...(dto.responsibleId !== undefined ? { responsibleId: dto.responsibleId } : {}),
        ...(dto.location !== undefined ? { location: dto.location?.trim() || null } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(backlogOps ? { backlogs: backlogOps } : {}),
      },
      include: { backlogs: true },
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
