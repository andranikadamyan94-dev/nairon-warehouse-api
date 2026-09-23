import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';
import { UsersPrismaService } from '../common/users-prisma.service';

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: ResourceWorkspaceService,
    private readonly usersPrisma: UsersPrismaService,
  ) {}

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
        message: 'Asset not found',
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

    return this.prisma.asset.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number, actor: WarehouseActor) {
    await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);

    return this.prisma.asset.delete({
      where: { id },
    });
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
