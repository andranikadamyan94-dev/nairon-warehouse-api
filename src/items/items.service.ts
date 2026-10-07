import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from 'prisma/prisma.service';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { GetItemsQueryDto } from './dto/get-items-query.dto';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import { UpdateImageDto } from './dto/update-image.dto';
import { CategoriesService } from 'src/categories/categories.service';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';
import { TxClient } from '../common/operations/operations.service';
import { FileService } from '../common/file.service';
import { roundQty } from '../common/quantity';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from '../common/notifications/notifications.service';
import { ReservationsService } from '../reservations/reservations.service';

/** A reservation still in play — the request is open (D1 / item_changed, 2026-10-07). */
export const LIVE_RESERVATION_STATUSES = ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'] as const;

const UNIT_LABELS: Record<string, string> = {
  KG: 'կգ', TONNE: 'տոննա', METER: 'մ', PIECE: 'հատ', HOUR: 'ժամ', BOX: 'տուփ', LITER: 'լ', SQUARE_METER: 'մ²',
};

/** Gallery cap per item (contract §9). */
const MAX_IMAGES = 10;

/** System-issued code, the same for an item and for a variant (RES-000042). */
const codeFor = (id: number) => `RES-${String(id).padStart(6, '0')}`;

/**
 * The relations GET /items/:id carries (catalog phase A, 2026-10-01):
 * variants (child items), characteristics, gallery, documents, the parent.
 */
const DETAIL_INCLUDE = {
  category: true,
  _count: { select: { assets: true } },
  parent: { select: { id: true, name: true } },
  variants: {
    select: { id: true, variantLabel: true, code: true, quantity: true },
    orderBy: { id: 'asc' },
  },
  attributes: {
    select: { id: true, name: true, value: true, order: true },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
  },
  images: {
    select: { id: true, url: true, order: true, isCover: true },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
  },
  documents: {
    select: { id: true, url: true, name: true, size: true, mime: true, order: true },
    orderBy: [{ order: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.ItemInclude;

/** A name's two halves, trimmed; the DTO already refused empty ones. */
const attributeRows = (itemId: number, attributes: { name: string; value: string }[]) =>
  attributes.map((a, i) => ({ itemId, name: a.name.trim(), value: a.value.trim(), order: i }));

/**
 * The parent's quantity is the sum of its children's when it has any (spec
 * 2.2) — its own counter is then not a stock figure. Rounded like every other
 * derived quantity.
 */
const sumOf = (own: number, children: { quantity: number }[] | undefined) =>
  children && children.length ? roundQty(children.reduce((s, v) => s + Number(v.quantity ?? 0), 0)) : own;

/**
 * The system code of an item: RES- and the row id, six digits wide
 * (RES-000042). Derived from the id, so it is unique and race-proof without a
 * counter of its own. Create issues it; assignCode issues the same one to an
 * item that predates auto-numbering and never got one.
 */
export const systemItemCode = (id: number) => `RES-${String(id).padStart(6, '0')}`;

/** No code yet: never set, or left blank by the old free-text field. */
export const hasNoCode = (code: string | null | undefined) => !code || !code.trim();

/** The refusal when an item already carries a code — codes are never changed. */
export const codeExistsMessage = (code: string) => `Կոդն արդեն կա՝ ${code}, այն փոխել հնարավոր չէ։`;

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoriesService: CategoriesService,
    private readonly stockAlerts: StockAlertService,
    private readonly workspaces: ResourceWorkspaceService,
    private readonly files: FileService,
    @Optional() private readonly notifications?: WarehouseNotificationsService,
    @Optional() private readonly reservations?: ReservationsService,
  ) {}

  private readonly logger = new Logger(ItemsService.name);

  /**
   * Can an item be filed under this category? The category has to exist; an
   * item may also have none.
   *
   * WAREHOUSE V1 CONTRACT: the catalogue is one shared pool. Who may file items
   * into it is `manage_items` on the route — not the company the category is
   * filed under, and not the companies the actor's roles live in.
   *
   * Called by create, by update when the category moves, and by the preflight
   * beside both, so the question is asked once and answered the same way.
   */
  async assertMayFileUnder(actor: WarehouseActor, categoryId?: number | null) {
    if (categoryId != null) await this.workspaces.ofCategory(categoryId);
  }

  /** Can this item be changed? It has to exist; authority is the route's `manage_items`. */
  async assertMayEdit(actor: WarehouseActor, id: number) {
    await this.workspaces.of('item', id);
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
          // Catalog (2026-10-01)
          brand: dto.brand ?? null,
          model: dto.model ?? null,
          description: dto.description ?? null,
          stockingMode: dto.stockingMode ?? 'STOCKED',
          catalogVisible: dto.catalogVisible ?? true,
        },
      });
      await client.item.update({
        where: { id: created.id },
        data: { code: systemItemCode(created.id) },
      });
      if (dto.attributes?.length) {
        await client.itemAttribute.createMany({ data: attributeRows(created.id, dto.attributes) });
      }
      // Read back through the same client: inside a transaction the row is
      // not yet visible to anyone else.
      return this.detail(created.id, client);
    };
    const item = tx ? await write(tx) : await this.prisma.$transaction((client) => write(client as TxClient));
    // An item can be created already at or below its threshold.
    this.stockAlerts.check([item.id]);
    return item;
  }

  async findAll(query?: GetItemsQueryDto, _actor?: WarehouseActor) {
    let categoryFilter: number[] | undefined;

    if (query?.categoryId) {
      categoryFilter = await this.categoriesService.getDescendantIds(
        Number(query.categoryId),
      );
    }

    // Not narrowed by who is asking. The catalogue is one shared pool for every
    // company, and the CRM task screen reads this route with no warehouse
    // permission at all — which companies somebody's roles live in, or where a
    // category is filed, hides nothing from them.
    const where: any = {
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
      // Variants (child items) sit under their parent's card; the list shows
      // them only when asked (?includeVariants=1).
      ...(query?.includeVariants === '1' ? {} : { parentItemId: null }),
    };

    // What the list carries per row beyond the item itself: the category, the
    // asset count, the cover picture, and the children the quantity sums over.
    const listInclude = {
      category: true,
      _count: { select: { assets: true } },
      images: { where: { isCover: true }, select: { url: true }, take: 1 },
      variants: { select: { id: true, quantity: true, _count: { select: { assets: true } } } },
    } satisfies Prisma.ItemInclude;

    type ListRow = {
      id: number;
      quantity: number;
      _count?: { assets: number };
      images?: { url: string }[];
      variants?: { id: number; quantity: number; _count?: { assets: number } }[];
    };

    /**
     * One list row. `coverUrl` out of the cover image; the quantity and asset
     * count summed over the children when there are any. `assetsOf` /
     * `quantityOf` let a warehouse scope read its own figures instead of the
     * global counters.
     */
    const shape = <T extends ListRow>(
      r: T,
      quantityOf: (id: number, own: number) => number,
      assetsOf: (id: number, own: number) => number,
    ) => {
      const { images, variants, ...rest } = r;
      const own = quantityOf(r.id, r.quantity);
      const quantity =
        variants && variants.length
          ? roundQty(variants.reduce((s, v) => s + quantityOf(v.id, Number(v.quantity ?? 0)), 0))
          : own;
      const assets =
        variants && variants.length
          ? variants.reduce((s, v) => s + assetsOf(v.id, v._count?.assets ?? 0), 0)
          : assetsOf(r.id, r._count?.assets ?? 0);
      return { ...rest, quantity, _count: { assets }, coverUrl: images?.[0]?.url ?? null };
    };

    // Sub-warehouse workspace (#1989 wave 2): the catalog is global, but a
    // sub's Ապրանքներ page shows ITS holdings — quantity comes from the sub's
    // stock row and the asset count from assets homed there; only items the
    // sub actually holds are listed (a parent whose variant is held counts).
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
        where: { ...where, OR: [{ id: { in: heldIds } }, { variants: { some: { id: { in: heldIds } } } }] },
        include: listInclude,
        orderBy: { id: 'desc' },
      });
      return rows.map((r) =>
        shape(
          r,
          (id) => stockOf.get(id) ?? 0,
          (id) => assetsOf.get(id) ?? 0,
        ),
      );
    }

    const rows = await this.prisma.item.findMany({
      where,

      include: listInclude,

      orderBy: {
        id: 'desc',
      },
    });

    const own = (_id: number, value: number) => value;
    if (query?.warehouseId !== 'main') return rows.map((r) => shape(r, own, own));
    // Main workspace: asset counts exclude rows homed in subs.
    const ids = rows.flatMap((r) => [r.id, ...(r.variants ?? []).map((v) => v.id)]);
    const mainCounts = await this.prisma.asset.groupBy({
      by: ['itemId'],
      where: { warehouseId: null, itemId: { in: ids } },
      _count: { id: true },
    });
    const mainOf = new Map(mainCounts.map((a) => [a.itemId, a._count.id]));
    return rows.map((r) => shape(r, own, (id) => mainOf.get(id) ?? 0));
  }

  /**
   * The full item, as GET /items/:id answers it: variants, attributes, images,
   * documents, parent — and the parent's quantity summed over its variants.
   */
  private async detail(id: number, client: TxClient | PrismaService = this.prisma) {
    const item = await client.item.findFirst({ where: { id }, include: DETAIL_INCLUDE });
    if (!item) {
      throw new NotFoundException({
        message: 'Ռեսուրսը չի գտնվել',
        itemId: id,
      });
    }
    return {
      ...item,
      quantity: sumOf(item.quantity, item.variants),
      parent: item.parent ?? null,
      variants: item.variants ?? [],
      attributes: item.attributes ?? [],
      images: item.images ?? [],
      documents: item.documents ?? [],
    };
  }

  async findOne(id: number, _actor?: WarehouseActor) {
    // The shared catalogue: every authenticated caller reads every item.
    return this.detail(id);
  }

  async update(id: number, dto: UpdateItemDto, actor: WarehouseActor) {
    const current = await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);
    // A new category has to exist; where it is filed refiles the item in the
    // books and refuses nobody — the catalogue is one shared pool.
    if (dto.categoryId !== undefined) await this.assertMayFileUnder(actor, dto.categoryId);

    /*
     * A variant inherits its name, type, unit and category from the parent
     * (spec 2.2); those are changed on the parent and flow down. Re-sending
     * the same values is fine — a form posts the whole record — only a
     * different value is refused.
     */
    const inherited = (['name', 'type', 'unit', 'categoryId'] as const).filter(
      (key) => dto[key] !== undefined && (dto[key] ?? null) !== (current[key] ?? null),
    );
    if (current.parentItemId != null && inherited.length) {
      throw new BadRequestException(
        'Տարբերակի անվանումը, տեսակը, միավորը և կատեգորիան ժառանգվում են հիմնական ապրանքից. փոխեք դրանք հիմնական ապրանքի վրա',
      );
    }

    // The code is system-issued and immutable — silently drop any attempt.
    const { code: _ignored, ...data } = dto as any;
    // Named explicitly rather than spread, for the same reason as create.
    // `quantity` stays on the route because the item screen has always
    // written it and taking it away would break that screen — but it is a
    // direct write to the stock counter with no InventoryMovement beside it,
    // so the trail of who moved what is not there. Anything acting on
    // somebody's behalf should leave it alone; the assistant's item tools do.
    const fields: Prisma.ItemUncheckedUpdateInput = {
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
      // Catalog (2026-10-01)
      ...(dto.brand !== undefined ? { brand: dto.brand ?? null } : {}),
      ...(dto.model !== undefined ? { model: dto.model ?? null } : {}),
      ...(dto.description !== undefined ? { description: dto.description ?? null } : {}),
      ...(dto.stockingMode !== undefined ? { stockingMode: dto.stockingMode } : {}),
      ...(dto.catalogVisible !== undefined ? { catalogVisible: dto.catalogVisible } : {}),
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.item.update({ where: { id }, data: fields });
      // «Բնութագրեր» are replaced as a whole; order = array order.
      if (dto.attributes !== undefined) {
        await tx.itemAttribute.deleteMany({ where: { itemId: id } });
        if (dto.attributes.length) await tx.itemAttribute.createMany({ data: attributeRows(id, dto.attributes) });
      }
      // What the parent is, its variants are.
      if (current.variants.length && inherited.length) {
        await tx.item.updateMany({
          where: { parentItemId: id },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.type !== undefined ? { type: dto.type } : {}),
            ...(dto.unit !== undefined ? { unit: dto.unit ?? null } : {}),
            ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId ?? null } : {}),
          },
        });
      }
    });
    // Re-evaluate: this edit may have set/raised the threshold or changed the
    // quantity directly, either of which can put the item below the line.
    this.stockAlerts.check([id]);
    // Phase 3 (2026-10-07): people with an open request for the item hear
    // that its quantity, unit or catalog visibility changed under them.
    const changes: string[] = [];
    if (dto.quantity !== undefined && Math.abs((dto.quantity ?? 0) - (current.quantity ?? 0)) > 1e-9) {
      changes.push(`քանակ՝ ${current.quantity ?? 0} → ${dto.quantity}`);
    }
    if (dto.unit !== undefined && (dto.unit ?? null) !== (current.unit ?? null)) {
      changes.push(`միավոր՝ ${UNIT_LABELS[current.unit ?? ''] ?? current.unit ?? '—'} → ${UNIT_LABELS[dto.unit ?? ''] ?? dto.unit ?? '—'}`);
    }
    if (dto.catalogVisible !== undefined && dto.catalogVisible !== current.catalogVisible) {
      changes.push(dto.catalogVisible ? 'կրկին երևում է կատալոգում' : 'հանվել է կատալոգից');
    }
    if (changes.length) {
      // A parent's unit flows down to its variants: their requests count too.
      const ids = [id, ...(dto.unit !== undefined ? current.variants.map((v: any) => v.id) : [])];
      void this.announceItemChanged(ids, current.name, changes, actor.userId);
    }
    return this.detail(id);
  }

  /**
   * The people with an open request for these items: the requesting side of
   * every live reservation (task assignees / the object's responsible person
   * / the catalog submitter), the requester and beneficiary of an open asset
   * request, the filer of a pending stock request. One notice each, linked to
   * their own request. Never throws.
   */
  async announceItemChanged(itemIds: number[], name: string, changes: string[], actorId: number | null) {
    try {
      if (!this.notifications) return;
      const pathOf = new Map<number, string>();
      const add = (userIds: (number | null | undefined)[], path: string) => {
        for (const u of userIds) if (u && !pathOf.has(u)) pathOf.set(u, path);
      };
      const live = await this.prisma.resourceReservation.findMany({
        where: { itemId: { in: itemIds }, status: { in: [...LIVE_RESERVATION_STATUSES] as any } },
        select: { id: true, taskId: true, objectId: true, submissionId: true },
      });
      if (this.reservations) {
        for (const r of live) {
          const side = await this.reservations.requesterSide(r);
          add(side.userIds, side.path);
        }
      }
      const assetRequests = await this.prisma.assetRequest.findMany({
        where: { itemId: { in: itemIds }, status: { in: ['PENDING', 'APPROVED'] } },
        select: { requestedBy: true, forUserId: true },
      });
      for (const a of assetRequests) add([a.forUserId, a.requestedBy], '/profile?tab=assets');
      const stockRequests = await this.prisma.stockRequest.findMany({
        where: { status: 'PENDING', items: { some: { itemId: { in: itemIds } } } },
        select: { createdBy: true },
      });
      add(stockRequests.map((s) => s.createdBy), '/stock-requests');
      const byPath = new Map<string, number[]>();
      for (const [u, p] of pathOf) byPath.set(p, [...(byPath.get(p) ?? []), u]);
      for (const [path, userIds] of byPath) {
        await this.notifications.sendToUsers(userIds, {
          type: WAREHOUSE_TYPES.itemChanged,
          actorId,
          title: 'Հայտված ապրանքը փոփոխվել է',
          body: `«${name}»՝ ${changes.join(', ')}։ Ձեր հայտը դեռ բաց է — ստուգեք այն։`,
          path,
          details: [{ label: 'Ապրանք', value: name }, { label: 'Փոփոխություն', value: changes.join(', ') }],
        });
      }
    } catch (e: any) {
      this.logger.warn(`item change notification failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Is this item still without a code? Asked by assignCode and by its
   * preflight, so both refuse the same item the same way. Returns the item.
   */
  async assertMayAssignCode(actor: WarehouseActor, id: number) {
    const item = await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);
    if (!hasNoCode(item.code)) {
      throw new ConflictException({
        message: codeExistsMessage(item.code as string),
        reason: 'ITEM_CODE_EXISTS',
        itemId: id,
        code: item.code,
      });
    }
    return item;
  }

  /**
   * Give an item that predates auto-numbering the system code create would
   * have given it (owner, 2026-10-02). Only ever fills an EMPTY code: an
   * existing code is never changed — that is still update()'s rule, and this
   * is not a way around it.
   *
   * The write is conditional on the code read a moment ago, so two people (or
   * a retry) racing on the same item cannot both win: the loser is refused
   * with the code the winner set.
   */
  async assignCode(id: number, actor: WarehouseActor, tx?: TxClient) {
    const before = await this.assertMayAssignCode(actor, id);
    const db = tx ?? this.prisma;
    const code = systemItemCode(id);
    let count: number;
    try {
      ({ count } = await db.item.updateMany({ where: { id, code: before.code ?? null }, data: { code } }));
    } catch (e: any) {
      // Somebody typed this very code onto another item by hand, back when
      // the field was free text. Do not guess another one.
      if (e?.code === 'P2002') {
        throw new ConflictException({
          message: `Կոդը՝ ${code}, արդեն զբաղված է այլ ապրանքի կողմից։`,
          reason: 'ITEM_CODE_TAKEN',
          itemId: id,
          code,
        });
      }
      throw e;
    }
    if (count === 0) {
      const now = await db.item.findFirst({ where: { id }, select: { code: true } });
      if (!now) throw new NotFoundException({ message: 'Ռեսուրսը չի գտնվել', itemId: id });
      throw new ConflictException({
        message: codeExistsMessage(now.code ?? ''),
        reason: 'ITEM_CODE_EXISTS',
        itemId: id,
        code: now.code,
      });
    }
    return db.item.findFirst({ where: { id }, include: { category: true } });
  }

  async remove(id: number, actor: WarehouseActor) {
    const item = await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);
    if (item.variants.length) {
      throw new BadRequestException('Ապրանքն ունի տարբերակներ. նախ ջնջեք դրանք');
    }
    // Data fix D1 (2026-10-07): the delete cascades reservations (catalog
    // request lines included), assets and custody — open requests and
    // custody records vanished without a trace. Refused while any is live,
    // as variant deletion already refuses.
    const [liveReservations, openCustody] = await Promise.all([
      this.prisma.resourceReservation.count({
        where: { itemId: id, status: { in: [...LIVE_RESERVATION_STATUSES] as any } },
      }),
      this.prisma.assetCustody.count({ where: { releasedAt: null, asset: { itemId: id } } }),
    ]);
    if (liveReservations > 0) {
      throw new BadRequestException(`Ապրանքն ունի ակտիվ ամրագրումներ (${liveReservations}) և չի կարող ջնջվել. նախ ավարտեք կամ չեղարկեք դրանք`);
    }
    if (openCustody > 0) {
      throw new BadRequestException(`Ապրանքի ակտիվները (${openCustody}) տրամադրված են պատասխանատուների և ապրանքը չի կարող ջնջվել. նախ գրանցեք վերադարձը`);
    }

    try {
      const removed = await this.prisma.item.delete({
        where: { id },
      });
      // The rows are gone (cascade); the bytes follow.
      for (const file of [...item.images, ...item.documents]) this.files.remove(file.url);
      return removed;
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

  // ── Variants (child items) ────────────────────────────────────────────────

  /** The parent row, or 404; a variant cannot itself have variants. */
  private async parentOrThrow(parentId: number) {
    const parent = await this.prisma.item.findUnique({ where: { id: parentId } });
    if (!parent) throw new NotFoundException({ message: 'Ռեսուրսը չի գտնվել', itemId: parentId });
    if (parent.parentItemId != null) {
      throw new BadRequestException('Տարբերակը չի կարող ունենալ իր տարբերակները');
    }
    return parent;
  }

  /** The child under this parent, or 404. */
  private async variantOrThrow(parentId: number, variantId: number) {
    const child = await this.prisma.item.findFirst({ where: { id: variantId, parentItemId: parentId } });
    if (!child) throw new NotFoundException({ message: 'Տարբերակը չի գտնվել', itemId: variantId });
    return child;
  }

  /** Two variants of one item cannot share a label; a code is unique across the catalogue. */
  private async assertVariantFree(parentId: number, label: string | undefined, code: string | null | undefined, exceptId?: number) {
    if (label !== undefined) {
      const clash = await this.prisma.item.findFirst({
        where: {
          parentItemId: parentId,
          variantLabel: { equals: label, mode: 'insensitive' },
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { id: true },
      });
      if (clash) throw new BadRequestException('Այս անվանումով տարբերակ արդեն կա');
    }
    if (code) {
      const taken = await this.prisma.item.findFirst({
        where: { code, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { id: true },
      });
      if (taken) throw new BadRequestException('Այս կոդն արդեն օգտագործվում է');
    }
  }

  /**
   * A variant is an item of its own with `parentItemId` set, so stock,
   * movements, reservations and procurement work on it unchanged. It takes
   * the parent's name, type, unit and category (and its stocking mode and
   * visibility, which describe the product rather than one colour of it).
   */
  async createVariant(parentId: number, dto: CreateVariantDto, actor: WarehouseActor) {
    const parent = await this.parentOrThrow(parentId);
    await this.assertMayEdit(actor, parentId);
    const label = dto.variantLabel.trim();
    const code = dto.code?.trim() || null;
    await this.assertVariantFree(parentId, label, code);

    return this.prisma.$transaction(async (tx) => {
      const created = await tx.item.create({
        data: {
          name: parent.name,
          secondaryName: parent.secondaryName,
          type: parent.type,
          unit: parent.unit,
          categoryId: parent.categoryId,
          unitCost: parent.unitCost,
          stockingMode: parent.stockingMode,
          catalogVisible: parent.catalogVisible,
          parentItemId: parentId,
          variantLabel: label,
          quantity: 0,
        },
      });
      return tx.item.update({
        where: { id: created.id },
        data: { code: code ?? codeFor(created.id) },
      });
    });
  }

  async updateVariant(parentId: number, variantId: number, dto: UpdateVariantDto, actor: WarehouseActor) {
    await this.parentOrThrow(parentId);
    await this.variantOrThrow(parentId, variantId);
    await this.assertMayEdit(actor, variantId);
    const label = dto.variantLabel !== undefined ? dto.variantLabel.trim() : undefined;
    // An emptied code goes back to the system-issued one.
    const code = dto.code === undefined ? undefined : dto.code?.trim() || codeFor(variantId);
    await this.assertVariantFree(parentId, label, code, variantId);
    return this.prisma.item.update({
      where: { id: variantId },
      data: {
        ...(label !== undefined ? { variantLabel: label } : {}),
        ...(code !== undefined ? { code } : {}),
      },
    });
  }

  /**
   * Refused while anything in the books points at the variant: stock (its
   * own counter or a warehouse row), registered assets, reservations, or a
   * movement history. Those are facts about goods, and a variant that has
   * them is not an empty label.
   */
  async removeVariant(parentId: number, variantId: number, actor: WarehouseActor) {
    await this.parentOrThrow(parentId);
    const child = await this.variantOrThrow(parentId, variantId);
    await this.assertMayEdit(actor, variantId);

    const [stocked, assets, reservations, movements] = await Promise.all([
      this.prisma.warehouseStock.count({ where: { itemId: variantId, quantity: { gt: 0 } } }),
      this.prisma.asset.count({ where: { itemId: variantId } }),
      this.prisma.resourceReservation.count({ where: { itemId: variantId } }),
      this.prisma.inventoryMovement.count({ where: { itemId: variantId } }),
    ]);
    if (Number(child.quantity) > 0 || stocked > 0) {
      throw new BadRequestException('Տարբերակն ունի պաշար և չի կարող ջնջվել');
    }
    if (assets > 0) throw new BadRequestException('Տարբերակն ունի գրանցված ակտիվներ և չի կարող ջնջվել');
    if (reservations > 0) throw new BadRequestException('Տարբերակն ունի ամրագրումներ և չի կարող ջնջվել');
    if (movements > 0) throw new BadRequestException('Տարբերակն ունի շարժերի պատմություն և չի կարող ջնջվել');

    try {
      return await this.prisma.item.delete({ where: { id: variantId } });
    } catch (e: any) {
      if (e?.code === 'P2003') {
        throw new BadRequestException('Տարբերակը ունի փոխանցումների պատմություն և չի կարող ջնջվել');
      }
      throw e;
    }
  }

  // ── Images ────────────────────────────────────────────────────────────────

  /**
   * Store the files first and only then write rows, so a file the allow-list
   * refuses leaves nothing behind: the ones stored before it are removed.
   */
  private storeAll(files: Express.Multer.File[], kind: 'image' | 'document'): string[] {
    const urls: string[] = [];
    try {
      for (const file of files) urls.push(this.files.upload(file, kind));
    } catch (e) {
      for (const url of urls) this.files.remove(url);
      throw e;
    }
    return urls;
  }

  async addImages(itemId: number, files: Express.Multer.File[] | undefined, actor: WarehouseActor) {
    await this.findOne(itemId, actor);
    await this.assertMayEdit(actor, itemId);
    if (!files?.length) throw new BadRequestException('Ֆայլը բացակայում է');

    const [existing, last] = await Promise.all([
      this.prisma.itemImage.count({ where: { itemId } }),
      this.prisma.itemImage.aggregate({ where: { itemId }, _max: { order: true } }),
    ]);
    if (existing + files.length > MAX_IMAGES) {
      throw new BadRequestException(`Մեկ ապրանքի համար թույլատրվում է առավելագույնը ${MAX_IMAGES} նկար`);
    }
    const urls = this.storeAll(files, 'image');
    const from = (last._max.order ?? -1) + 1;
    await this.prisma.itemImage.createMany({
      data: urls.map((url, i) => ({
        itemId,
        url,
        order: from + i,
        // The first image an item ever gets is its cover.
        isCover: existing === 0 && i === 0,
      })),
    });
    return this.detail(itemId);
  }

  async updateImage(itemId: number, imageId: number, dto: UpdateImageDto, actor: WarehouseActor) {
    await this.findOne(itemId, actor);
    await this.assertMayEdit(actor, itemId);
    const image = await this.prisma.itemImage.findFirst({ where: { id: imageId, itemId } });
    if (!image) throw new NotFoundException('Նկարը չի գտնվել');

    await this.prisma.$transaction(async (tx) => {
      // One cover per item: the previous one steps down.
      if (dto.isCover === true && !image.isCover) {
        await tx.itemImage.updateMany({ where: { itemId, isCover: true }, data: { isCover: false } });
      }
      await tx.itemImage.update({
        where: { id: imageId },
        data: {
          ...(dto.isCover === true ? { isCover: true } : {}),
          ...(dto.order !== undefined ? { order: dto.order } : {}),
        },
      });
    });
    return this.detail(itemId);
  }

  async removeImage(itemId: number, imageId: number, actor: WarehouseActor) {
    await this.findOne(itemId, actor);
    await this.assertMayEdit(actor, itemId);
    const image = await this.prisma.itemImage.findFirst({ where: { id: imageId, itemId } });
    if (!image) throw new NotFoundException('Նկարը չի գտնվել');

    await this.prisma.$transaction(async (tx) => {
      await tx.itemImage.delete({ where: { id: imageId } });
      // The cover is gone: the first remaining picture takes its place.
      if (image.isCover) {
        const next = await tx.itemImage.findFirst({
          where: { itemId },
          orderBy: [{ order: 'asc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (next) await tx.itemImage.update({ where: { id: next.id }, data: { isCover: true } });
      }
    });
    this.files.remove(image.url);
    return this.detail(itemId);
  }

  // ── Documents ─────────────────────────────────────────────────────────────

  async addDocuments(itemId: number, files: Express.Multer.File[] | undefined, actor: WarehouseActor) {
    await this.findOne(itemId, actor);
    await this.assertMayEdit(actor, itemId);
    if (!files?.length) throw new BadRequestException('Ֆայլը բացակայում է');

    const last = await this.prisma.itemDocument.aggregate({ where: { itemId }, _max: { order: true } });
    const urls = this.storeAll(files, 'document');
    const from = (last._max.order ?? -1) + 1;
    await this.prisma.itemDocument.createMany({
      data: files.map((file, i) => ({
        itemId,
        url: urls[i],
        // Multer hands the name over as latin1; the same decode as attachments.
        name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        size: file.size,
        mime: file.mimetype,
        order: from + i,
      })),
    });
    return this.detail(itemId);
  }

  async removeDocument(itemId: number, documentId: number, actor: WarehouseActor) {
    await this.findOne(itemId, actor);
    await this.assertMayEdit(actor, itemId);
    const doc = await this.prisma.itemDocument.findFirst({ where: { id: documentId, itemId } });
    if (!doc) throw new NotFoundException('Փաստաթուղթը չի գտնվել');
    await this.prisma.itemDocument.delete({ where: { id: documentId } });
    this.files.remove(doc.url);
    return this.detail(itemId);
  }
}
