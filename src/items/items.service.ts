import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { GetItemsQueryDto } from './dto/get-items-query.dto';
import { CategoriesService } from 'src/categories/categories.service';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';
import { TxClient } from '../common/operations/operations.service';

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoriesService: CategoriesService,
    private readonly stockAlerts: StockAlertService,
    private readonly workspaces: ResourceWorkspaceService,
  ) {}

  /**
   * May this person put an item in this part of the catalogue?
   *
   * An item's workspace is its category's, so filing it is the moment its
   * workspace is decided — and the only moment worth checking, since an item
   * with no category has no workspace at all. A bounded actor cannot create
   * one, because there would be nowhere for it to be.
   *
   * Called by create, by update when the category moves, and by the preflight
   * beside both, so the question is asked once and answered the same way.
   */
  async assertMayFileUnder(actor: WarehouseActor, categoryId?: number | null) {
    const workspace =
      categoryId == null ? null : (await this.workspaces.ofCategory(categoryId)).workspace;
    this.workspaces.assertMayTouchWorkspace(actor, 'item', workspace);
  }

  /** May this person change this item? Its workspace is its category's. */
  async assertMayEdit(actor: WarehouseActor, id: number) {
    await this.workspaces.assertMayTouch(actor, 'item', id);
  }

  /**
   * `tx` lets a caller run this inside a transaction it also writes its own
   * bookkeeping into — see OperationsService, which commits "this happened"
   * together with the thing that happened. Absent, it is an ordinary call.
   */
  async create(dto: CreateItemDto, actor: WarehouseActor, tx?: TxClient) {
    await this.assertMayFileUnder(actor, dto.categoryId);

    /*
     * Three things at once, and all three matter.
     *
     * LOCAL — the fields are named one by one rather than spread. The DTO is
     * the shape of a request and the row is the shape of a fact; treating them
     * as one thing is how `maintenanceRequired`, a field in no schema, reached
     * Prisma and failed there. Remote's `...data` spread would bring that back.
     *
     * REMOTE — the code is generated from the row id (RES-000042), so
     * uniqueness is free and race-proof. Whatever the client sends is ignored;
     * `code` stayed on the DTO for compatibility only. So local's
     * `code: dto.code ?? null` is gone deliberately.
     *
     * LOCAL again — `tx` lets a caller run this inside a transaction it also
     * writes its own bookkeeping into (OperationsService). Remote opened its
     * own transaction unconditionally, which would nest inside that one; the
     * caller's transaction is used when there is one.
     */
    const db = tx ?? this.prisma;
    const write = async (client: TxClient) => {
      const created = await client.item.create({
        data: {
          name: dto.name,
          secondaryName: dto.secondaryName ?? null,
          type: dto.type,
          unit: dto.unit ?? null,
          quantity: dto.quantity ?? 0,
          minQuantity: dto.minQuantity ?? null,
          notes: dto.notes ?? null,
          categoryId: dto.categoryId ?? null,
        },
      });
      return client.item.update({
        where: { id: created.id },
        data: { code: `RES-${String(created.id).padStart(6, '0')}` },
      });
    };
    const item = tx ? await write(tx) : await this.prisma.$transaction((client) => write(client as TxClient));
    // An item can be created already at or below its threshold.
    this.stockAlerts.check([item.id]);
    return item;
  }

  async findAll(query?: GetItemsQueryDto, actor?: WarehouseActor) {
    let categoryFilter: number[] | undefined;

    if (query?.categoryId) {
      categoryFilter = await this.categoriesService.getDescendantIds(
        Number(query.categoryId),
      );
    }

    // Narrowed only for an actor whose roles live in particular companies.
    // Not by the workspace they declared: stock is a shared pool, and a company
    // that keeps no catalogue of its own still reserves from the ones that do.
    // Everyone in this installation holds a wildcard role, so today this adds no
    // filter and the list is the list it always was — deliberately, because the
    // CRM task screen reads this route with no warehouse permission at all.
    const scope = actor ? this.workspaces.scopeFor(actor, ['category']) : undefined;

    const where: any = {
      // Local's actor scope leads, so every branch below — including the
      // sub-warehouse one remote added — narrows from inside it rather than
      // beside it.
      ...(scope ?? {}),
      ...(categoryFilter ? { categoryId: { in: categoryFilter } } : {}),
      ...(query?.uncategorized === '1' ? { categoryId: null } : {}),
      ...(query?.type ? { type: query.type } : {}),
      // Either name, or the code — people search by whichever they know.
      ...(query?.search
        ? {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { secondaryName: { contains: query.search, mode: 'insensitive' } },
              { code: { contains: query.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    // Sub-warehouse workspace (#1989 wave 2): the catalog is global, but a
    // sub's Ապրանքներ page shows ITS holdings — quantity comes from the sub's
    // stock row and the asset count from assets homed there; only items the
    // sub actually holds are listed.
    if (query?.warehouseId && query.warehouseId !== 'main') {
      const whId = Number(query.warehouseId);
      const [stocks, assetCounts] = await Promise.all([
        this.prisma.warehouseStock.findMany({
          where: { warehouseId: whId, quantity: { gt: 0 } },
          select: { itemId: true, quantity: true },
        }),
        this.prisma.asset.groupBy({
          by: ['itemId'],
          where: { warehouseId: whId },
          _count: { id: true },
        }),
      ]);
      const stockOf = new Map(stocks.map((s) => [s.itemId, s.quantity]));
      const assetsOf = new Map(assetCounts.map((a) => [a.itemId, a._count.id]));
      const heldIds = [...new Set([...stockOf.keys(), ...assetsOf.keys()])];
      const rows = await this.prisma.item.findMany({
        where: { ...where, id: { in: heldIds } },
        include: { category: true },
        orderBy: { id: 'desc' },
      });
      return rows.map((r) => ({
        ...r,
        quantity: stockOf.get(r.id) ?? 0,
        _count: { assets: assetsOf.get(r.id) ?? 0 },
      }));
    }

    const rows = await this.prisma.item.findMany({
      where,

      include: {
        category: true,
        _count: { select: { assets: true } },
      },

      orderBy: {
        id: 'desc',
      },
    });

    if (query?.warehouseId !== 'main') return rows;
    // Main workspace: asset counts exclude rows homed in subs.
    const mainCounts = await this.prisma.asset.groupBy({
      by: ['itemId'],
      where: { warehouseId: null, itemId: { in: rows.map((r) => r.id) } },
      _count: { id: true },
    });
    const mainOf = new Map(mainCounts.map((a) => [a.itemId, a._count.id]));
    return rows.map((r) => ({ ...r, _count: { assets: mainOf.get(r.id) ?? 0 } }));
  }

  async findOne(id: number, actor?: WarehouseActor) {
    // Out of scope reads as missing rather than as forbidden: a bounded actor
    // learns nothing about another company's catalogue, not even that a given
    // id is taken.
    const scope = actor ? this.workspaces.scopeFor(actor, ['category']) : undefined;
    const item = await this.prisma.item.findFirst({
      where: { id, ...(scope ?? {}) },
      include: {
        category: true,
        _count: { select: { assets: true } },
      },
    });

    if (!item) {
      throw new NotFoundException({
        message: 'Item not found',
        itemId: id,
      });
    }

    return item;
  }

  async update(id: number, dto: UpdateItemDto, actor: WarehouseActor) {
    await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);
    // Moving an item into another company's catalogue moves the item itself.
    // The destination has to be somewhere this person could have created it.
    if (dto.categoryId !== undefined) await this.assertMayFileUnder(actor, dto.categoryId);

    // The code is system-issued and immutable — silently drop any attempt.
    const { code: _ignored, ...data } = dto as any;
    const item = await this.prisma.item.update({
      where: { id },
      // Named explicitly rather than spread, for the same reason as create.
      // `quantity` stays on the route because the item screen has always
      // written it and taking it away would break that screen — but it is a
      // direct write to the stock counter with no InventoryMovement beside it,
      // so the trail of who moved what is not there. Anything acting on
      // somebody's behalf should leave it alone; the assistant's item tools do.
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        // `code` is deliberately absent. It is system-issued and immutable
        // since origin/staging, and the destructure above already drops it.
        ...(dto.secondaryName !== undefined ? { secondaryName: dto.secondaryName ?? null } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit ?? null } : {}),
        ...(dto.minQuantity !== undefined ? { minQuantity: dto.minQuantity } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes ?? null } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId ?? null } : {}),
        ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
      },
    });
    // Re-evaluate: this edit may have set/raised the threshold or changed the
    // quantity directly, either of which can put the item below the line.
    this.stockAlerts.check([id]);
    return item;
  }

  async remove(id: number, actor: WarehouseActor) {
    await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);

    try {
      return await this.prisma.item.delete({
        where: { id },
      });
    } catch (e: any) {
      // RESTRICT on transfer lines is deliberate — surface it as a message,
      // not a 500.
      if (e?.code === 'P2003') {
        throw new BadRequestException(
          'Ապրանքը ունի փոխանցումների պատմություն և չի կարող ջնջվել',
        );
      }
      throw e;
    }
  }
}
