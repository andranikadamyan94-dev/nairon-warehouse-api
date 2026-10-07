import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';
import { UsersPrismaService } from '../common/users-prisma.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from '../common/notifications/notifications.service';
import { ObjectsService } from '../objects/objects.service';
import { ReservationsService } from '../reservations/reservations.service';

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: ResourceWorkspaceService,
    private readonly usersPrisma: UsersPrismaService,
    @Optional() private readonly notifications?: WarehouseNotificationsService,
    @Optional() private readonly objects?: ObjectsService,
    @Optional() private readonly reservations?: ReservationsService,
  ) {}

  private readonly logger = new Logger(AssetsService.name);

  /**
   * Who holds this asset right now (phase 3, 2026-10-07): its open custody's
   * person — or, for an object, the object's responsible person — and the
   * requesting side of a task it is issued to. Read BEFORE the change, since
   * a delete cascades the rows away.
   */
  private async holdersOf(assetId: number): Promise<{ userId: number; path: string }[]> {
    const out: { userId: number; path: string }[] = [];
    const custody = await this.prisma.assetCustody.findMany({
      where: { assetId, releasedAt: null },
      select: { holderUserId: true, holderObjectId: true },
    });
    for (const c of custody) {
      if (c.holderUserId) out.push({ userId: c.holderUserId, path: '/profile?tab=assets' });
      else if (c.holderObjectId && this.objects) {
        const o = await this.objects.crmObject(c.holderObjectId).catch(() => null);
        if (o?.responsibleId) out.push({ userId: o.responsibleId, path: `/objects/${c.holderObjectId}` });
      }
    }
    const allocations = await this.prisma.reservationAllocation.findMany({
      where: { assetId, releasedAt: null },
      select: { reservation: { select: { id: true, taskId: true, objectId: true, submissionId: true } } },
    });
    for (const a of allocations) {
      if (!this.reservations || !a.reservation) continue;
      const side = await this.reservations.requesterSide(a.reservation);
      for (const u of side.userIds) out.push({ userId: u, path: side.path });
    }
    return out;
  }

  private async announceStatusChanged(
    holders: { userId: number; path: string }[],
    asset: { id: number; name?: string | null; serialNumber?: string | null; item?: { name: string } | null },
    what: string,
    actorId: number | null,
  ) {
    try {
      if (!this.notifications || !holders.length) return;
      const label = `${asset.item?.name ?? asset.name ?? 'Գույք'}${asset.serialNumber ? ` (${asset.serialNumber})` : ''}`;
      const byPath = new Map<string, number[]>();
      const seen = new Set<number>();
      for (const h of holders) {
        if (seen.has(h.userId)) continue;
        seen.add(h.userId);
        byPath.set(h.path, [...(byPath.get(h.path) ?? []), h.userId]);
      }
      for (const [path, userIds] of byPath) {
        await this.notifications.sendToUsers(userIds, {
          type: WAREHOUSE_TYPES.assetStatusChanged,
          actorId,
          title: 'Ձեր մոտ գտնվող գույքի կարգավիճակը փոխվել է',
          body: `${label}՝ ${what}։`,
          path,
          details: [{ label: 'Գույք', value: label }, { label: 'Փոփոխություն', value: what }],
        });
      }
    } catch (e: any) {
      this.logger.warn(`asset status notification failed: ${e?.message ?? e}`);
    }
  }

  /**
   * An asset is a serial-numbered instance of an item, so the item has to exist
   * before one is made. Authority is `manage_assets` on the route: the
   * catalogue is one shared pool, and where the item is filed refuses nobody.
   */
  async assertMayCreateFor(actor: WarehouseActor, itemId: number) {
    await this.workspaces.of('item', itemId);
  }

  /** Can this asset be changed? It has to exist; authority is the route's `manage_assets`. */
  async assertMayEdit(actor: WarehouseActor, id: number) {
    await this.workspaces.of('asset', id);
  }

  async create(dto: CreateAssetDto, actor: WarehouseActor) {
    await this.assertMayCreateFor(actor, dto.itemId);

    return this.prisma.asset.create({
      data: dto,
    });
  }

  /**
   * The `warehouseId` filter (#1989 sub-warehouses) says WHICH warehouse you are
   * looking at. Nothing narrows by who is asking: `view_assets`/`manage_assets`
   * on the route is the authority, and the pool is shared by every company.
   */
  findAll(
    query?: {
      status?: string;
      search?: string;
      sortBy?: string;
      sortOrder?: string;
      warehouseId?: string;
    },
    _actor?: WarehouseActor,
  ) {
    const where: any = {};
    if (query?.status) where.status = query.status;
    // #1989 workspaces: 'main' = the null-homed pool (all pre-existing rows).
    if (query?.warehouseId === 'main') where.warehouseId = null;
    else if (query?.warehouseId) where.warehouseId = Number(query.warehouseId);
    if (query?.search) {
      where.OR = [
        { serialNumber: { contains: query.search, mode: 'insensitive' } },
        { item: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }
    const order: 'asc' | 'desc' = query?.sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: any =
      query?.sortBy === 'serialNumber' ? { serialNumber: order }
      : query?.sortBy === 'itemName' ? { item: { name: order } }
      : query?.sortBy === 'status' ? { status: order }
      : { createdAt: 'desc' };
    return this.prisma.asset.findMany({ where, include: { item: true }, orderBy });
  }

  async findOne(id: number, _actor?: WarehouseActor) {
    const asset = await this.prisma.asset.findFirst({
      where: { id },

      include: {
        item: true,
        maintenanceRecords: true,
        responsibilities: true,
        allocations: true,
      },
    });

    if (!asset) {
      throw new NotFoundException({
        message: 'Ակտիվը չի գտնվել',
        assetId: id,
      });
    }

    return asset;
  }

  async update(id: number, dto: UpdateAssetDto, actor: WarehouseActor) {
    await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);
    // The item it moves onto has to exist.
    if (dto.itemId !== undefined) await this.assertMayCreateFor(actor, dto.itemId);

    const before = await this.prisma.asset.findUnique({ where: { id }, include: { item: true } });
    // Phase 3 (2026-10-07): retired (lost / written off) while somebody holds it.
    const retiring = dto.status === 'RETIRED' && before?.status !== 'RETIRED';
    const holders = retiring ? await this.holdersOf(id).catch(() => []) : [];
    const updated = await this.prisma.asset.update({
      where: { id },
      data: dto,
    });
    if (retiring && before) {
      void this.announceStatusChanged(holders, before, 'նշվել է դուրս գրված (կորած / շահագործումից հանված)', actor?.userId ?? null);
    }
    return updated;
  }

  async remove(id: number, actor: WarehouseActor) {
    await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);

    // Phase 3 (2026-10-07): the delete cascades the custody rows — tell the holders first.
    const before = await this.prisma.asset.findUnique({ where: { id }, include: { item: true } });
    const holders = await this.holdersOf(id).catch(() => []);
    const removed = await this.prisma.asset.delete({
      where: { id },
    });
    if (before) void this.announceStatusChanged(holders, before, 'ջնջվել է պահեստի գրանցամատյանից', actor?.userId ?? null);
    return removed;
  }

  async getAvailableAssets(query: {
    itemId: number;
    startDate: string;
    endDate?: string;
    reservationId?: number;
  }) {
    const startDate = new Date(query.startDate);
    const endDate = query.endDate ? new Date(query.endDate) : null;

    // #1989 workspaces: offer only assets homed in the reservation's pool —
    // a sub-linked task must not be handed a main-warehouse asset (or vice
    // versa). Without a reservation context, the main pool is assumed.
    let poolWarehouseId: number | null = null;
    if (query.reservationId) {
      const resv = await this.prisma.resourceReservation.findUnique({
        where: { id: query.reservationId },
        select: { warehouseId: true },
      });
      poolWarehouseId = resv?.warehouseId ?? null;
    }

    const ownReservationFilter = query.reservationId
      ? { reservationId: { not: query.reservationId } }
      : {};

    // An active allocation blocks this asset if:
    //   - it is open-ended (endDate = null), OR
    //   - its reservation overlaps the requested window
    const overlapFilter = endDate
      ? {
          OR: [
            { reservation: { endDate: null } },
            { reservation: { startDate: { lte: endDate }, endDate: { gte: startDate } } },
          ],
        }
      : { reservation: { endDate: null } }; // requesting open-ended: only blocked by other open-ended

    const maintenanceFilter = endDate
      ? { startDate: { lte: endDate }, endDate: { gte: startDate } }
      : { startDate: { gte: startDate } }; // open-ended: blocked by any future maintenance

    // Asset custody (2026-09-23): a task only takes an asset that already has a
    // responsible person, so only those are offered — with the person's name.
    const rows = await this.prisma.asset.findMany({
      where: {
        itemId: query.itemId,
        warehouseId: poolWarehouseId,
        allocations: {
          none: {
            releasedAt: null,
            ...ownReservationFilter,
            ...overlapFilter,
          },
        },
        maintenanceRecords: {
          none: maintenanceFilter,
        },
        custodies: { some: { releasedAt: null, holderType: 'USER' } },
      },
      include: {
        item: true,
        custodies: { where: { releasedAt: null }, select: { holderUserId: true } },
      },
    });
    const ids = [...new Set(rows.map((r) => r.custodies[0]?.holderUserId).filter((x): x is number => !!x))];
    const users = ids.length ? await this.usersPrisma.getUsersByIds(ids) : [];
    const name = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return rows.map(({ custodies, ...asset }) => {
      const responsibleUserId = custodies[0]?.holderUserId ?? null;
      return { ...asset, responsibleUserId, responsibleName: responsibleUserId ? name.get(responsibleUserId) ?? `#${responsibleUserId}` : null };
    });
  }

  async getAssetHistory(assetId: number) {
    return this.prisma.asset.findUnique({
      where: {
        id: assetId,
      },

      include: {
        allocations: {
          include: {
            reservation: true,
          },
        },

        maintenanceRecords: true,

        responsibilities: true,
      },
    });
  }

  getItemHistory(itemId: number) {
    return this.prisma.asset.findMany({
      where: { itemId },
      orderBy: { createdAt: 'asc' },
      include: {
        allocations: {
          include: { reservation: { select: { id: true, taskId: true, projectName: true, startDate: true, endDate: true, notes: true } } },
          orderBy: { allocatedAt: 'asc' },
        },
        maintenanceRecords: { orderBy: { startDate: 'asc' } },
        responsibilities: { orderBy: { id: 'asc' } },
      },
    });
  }
}
