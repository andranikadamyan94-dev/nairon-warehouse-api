import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { WarehouseActor } from '../auth/actor';
import { CategoriesService } from '../categories/categories.service';
import { FileService } from '../common/file.service';
import { requireInternalSecret } from '../common/internal-headers';
import { roundQty } from '../common/quantity';
import { reservationStatusLabel } from '../common/status-labels';
import { UsersPrismaService } from '../common/users-prisma.service';
import { getYerevanDateKey } from '../common/utils/date.utils';
import { ItemType } from '../common/enums/item-type.enum';
import {
  APPROVE_PERMISSION,
  LineInput,
  PurchaseRequisitionsService,
} from '../purchase-requisitions/purchase-requisitions.service';
import { ReservationsService } from '../reservations/reservations.service';

import {
  ApprovalRights,
  Availability,
  LineKind,
  LineStage,
  SubmissionStatus,
  SUBMISSION_STATUSES,
  approvalRights,
  availabilityOf,
  deriveStatus,
  formatSubmissionNumber,
  lineIdOf,
  parseLineId,
  partitionByRights,
  progressOf,
  splitCheckout,
  stageOf,
  stillEditable,
} from './catalog.rules';
import { CheckoutDto } from './dto/checkout.dto';
import { ApproveSubmissionDto, EditSubmissionDto } from './dto/submission-actions.dto';

/** The queue's permission (D4). Granted per environment by the owner; auth-api seeds the name. */
export const QUEUE_PERMISSION = 'view_catalog_requests';

const PAGE = 20;

/** What a purchase-requisition status means to the person who asked through the catalog. */
const REQUISITION_LABELS: Record<string, string> = {
  DRAFT: 'Տեղեկություն է պետք',
  PENDING_APPROVAL: 'Սպասում է հաստատման',
  SUBMITTED: 'Հաստատված՝ գնումների բաժնում',
  IN_REVIEW: 'Դիտարկվում է գնումների կողմից',
  APPROVED: 'Պատվիրված',
  REJECTION_PENDING: 'Մերժված (սպասում է հաստատման)',
  REJECTED: 'Մերժված',
  CANCELLED: 'Չեղարկված',
  FULFILLED: 'Ստացված',
};

const RESERVATION_LIVE = ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'];
const REQUISITION_CANCELLABLE = ['DRAFT', 'PENDING_APPROVAL', 'SUBMITTED', 'IN_REVIEW'];

export type SubmissionLine = {
  id: string;
  kind: LineKind;
  itemId: number | null;
  itemName: string;
  variantLabel: string | null;
  code: string | null;
  unit: string | null;
  quantity: number;
  approvedQuantity: number | null;
  inStock: number | null;
  status: string;
  statusLabel: string;
  reservationId: number | null;
  requisitionId: number | null;
  requisitionLineId: number | null;
  /** Internal: where the line stands for the derivation. Not part of the contract. */
  stage: LineStage;
};

type Person = { id: number; name: string } | null;

export type SubmissionView = {
  id: number;
  number: string;
  createdAt: string;
  createdBy: number;
  requester: { id: number; firstName: string; lastName: string; unitName: string | null; entityName: string | null };
  entityId: number | null;
  projectId: number | null;
  projectName: string | null;
  costCenter: string | null;
  purpose: string;
  neededBy: string;
  comment: string | null;
  attachmentUrl: string | null;
  status: SubmissionStatus;
  progress: { ready: number; total: number };
  canEdit: boolean;
  canCancel: boolean;
  lines: Omit<SubmissionLine, 'stage'>[];
  timeline: { at: string; kind: string; by: Person; text: string }[];
  infoRequest: { at: string; by: Person; text: string } | null;
  approver: Person;
};

/** Everything one submission is made of, as loaded in one pass. */
type Loaded = {
  sub: any;
  reservations: any[];
  requisition: any | null;
};

type Directory = {
  unitOf: Map<number, { unitId: number; unitName: string; entityId: number }>;
  entityName: Map<number, string>;
};

/**
 * Warehouse «Կատալոգ», phases B/C (2026-10-01).
 *
 * A front door onto the existing flows (D1): the catalog lists items with
 * their availability, a checkout becomes one reservation per stocked line
 * plus ONE purchase requisition for the rest, grouped by a CatalogSubmission
 * whose status is derived from those rows (§4/§10 of the build spec). Nothing
 * here invents a status, a permission for approving, or a notification.
 */
@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  /** HR's unit and organization names, briefly — asked on every list. */
  private directoryCache: { at: number; value: Promise<Directory> } | null = null;
  private static readonly DIRECTORY_FRESH_MS = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersPrisma: UsersPrismaService,
    private readonly reservations: ReservationsService,
    private readonly requisitions: PurchaseRequisitionsService,
    private readonly categories: CategoriesService,
    private readonly fileService: FileService,
  ) {}

  // ── Catalog (employee) ────────────────────────────────────────────────────

  private readonly listInclude = {
    category: { select: { id: true, name: true } },
    images: { where: { isCover: true }, select: { url: true }, take: 1 },
    variants: { select: { id: true, variantLabel: true, code: true }, orderBy: { id: 'asc' as const } },
  };

  async listItems(query: Record<string, string | undefined>) {
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(query.pageSize ?? 24) || 24));
    const q = query.q?.trim();
    const categoryId = Number(query.categoryId ?? 0);
    const where: any = {
      parentItemId: null,
      catalogVisible: true,
      ...(categoryId > 0 ? { categoryId: { in: await this.categories.getDescendantIds(categoryId) } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { secondaryName: { contains: q, mode: 'insensitive' } },
              { code: { contains: q, mode: 'insensitive' } },
              { brand: { contains: q, mode: 'insensitive' } },
              { model: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.item.findMany({
        where,
        include: this.listInclude,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.item.count({ where }),
    ]);
    const free = await this.freeStock(rows.flatMap((r) => [r.id, ...r.variants.map((v) => v.id)]));
    return { items: rows.map((r) => this.catalogItem(r, free)), total };
  }

  async getItem(id: number) {
    const row = await this.prisma.item.findFirst({
      where: { id, parentItemId: null, catalogVisible: true },
      include: {
        ...this.listInclude,
        attributes: { orderBy: { order: 'asc' } },
        documents: { orderBy: { order: 'asc' } },
      },
    });
    if (!row) throw new NotFoundException('Ապրանքը չի գտնվել');
    const gallery = await this.prisma.itemImage.findMany({ where: { itemId: id }, orderBy: [{ isCover: 'desc' }, { order: 'asc' }] });
    const free = await this.freeStock([row.id, ...row.variants.map((v) => v.id)]);
    return {
      ...this.catalogItem(row, free),
      description: row.description ?? null,
      attributes: row.attributes.map((a) => ({ id: a.id, name: a.name, value: a.value, order: a.order })),
      images: gallery.map((i) => ({ id: i.id, url: i.url, order: i.order, isCover: i.isCover })),
      documents: row.documents.map((d) => ({ id: d.id, url: d.url, name: d.name, size: d.size, mime: d.mime, order: d.order })),
    };
  }

  /** The dropdown («Բոլոր բաժինները»): every category with how many visible items it holds directly. */
  async listCategories() {
    const [categories, counts] = await Promise.all([
      this.prisma.itemCategory.findMany({ orderBy: [{ position: 'asc' }, { name: 'asc' }], select: { id: true, name: true } }),
      this.prisma.item.groupBy({
        by: ['categoryId'],
        where: { parentItemId: null, catalogVisible: true, categoryId: { not: null } },
        _count: { id: true },
      }),
    ]);
    const countOf = new Map(counts.map((c) => [c.categoryId, c._count.id]));
    return categories.map((c) => ({ id: c.id, name: c.name, count: countOf.get(c.id) ?? 0 }));
  }

  private catalogItem(r: any, free: Map<number, number>) {
    const variants = (r.variants ?? []).map((v: any) => ({
      id: v.id,
      variantLabel: v.variantLabel ?? null,
      code: v.code ?? null,
      inStock: free.get(v.id) ?? 0,
    }));
    const inStock = variants.length
      ? roundQty(variants.reduce((s: number, v: any) => s + v.inStock, 0))
      : free.get(r.id) ?? 0;
    return {
      id: r.id,
      name: r.name,
      secondaryName: r.secondaryName ?? null,
      brand: r.brand ?? null,
      model: r.model ?? null,
      categoryId: r.categoryId ?? null,
      categoryName: r.category?.name ?? null,
      unit: r.unit ?? null,
      stockingMode: r.stockingMode,
      coverUrl: r.images?.[0]?.url ?? null,
      inStock,
      availability: availabilityOf(r.stockingMode, inStock) as Availability,
      variants,
    };
  }

  /**
   * How much of each item the catalog may promise right now — the pool a
   * catalog reservation draws from, measured as the create path measures it:
   * the main shelf less every PENDING / APPROVED claim on it that has not
   * expired. Assets: the AVAILABLE units in the main pool less live claims.
   *
   * Only the main pool: a catalog request names no task, and a task is what
   * binds a request to a project warehouse today. The list has no project
   * context to measure a sub-warehouse against.
   */
  private async freeStock(itemIds: number[]): Promise<Map<number, number>> {
    const ids = [...new Set(itemIds)];
    const result = new Map<number, number>();
    if (!ids.length) return result;
    const now = new Date();
    const items = await this.prisma.item.findMany({ where: { id: { in: ids } }, select: { id: true, type: true, quantity: true } });
    const current = { OR: [{ endDate: null }, { endDate: { gte: now } }] };
    const consumableIds = items.filter((i) => i.type === ItemType.CONSUMABLE).map((i) => i.id);
    const assetIds = items.filter((i) => i.type === ItemType.ASSET).map((i) => i.id);
    const [claims, assetUnits, assetClaims] = await Promise.all([
      consumableIds.length
        ? this.prisma.resourceReservation.groupBy({
            by: ['itemId'],
            where: { itemId: { in: consumableIds }, warehouseId: null, status: { in: ['PENDING', 'APPROVED'] }, ...current },
            _sum: { quantity: true },
          })
        : [],
      assetIds.length
        ? this.prisma.asset.groupBy({ by: ['itemId'], where: { itemId: { in: assetIds }, status: 'AVAILABLE', warehouseId: null }, _count: { id: true } })
        : [],
      assetIds.length
        ? this.prisma.resourceReservation.groupBy({
            by: ['itemId'],
            where: { itemId: { in: assetIds }, status: { in: ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'] }, ...current },
            _sum: { quantity: true },
          })
        : [],
    ]);
    const claimed = new Map((claims as any[]).map((c) => [c.itemId, c._sum.quantity ?? 0]));
    const units = new Map((assetUnits as any[]).map((a) => [a.itemId, a._count.id]));
    const assetClaimed = new Map((assetClaims as any[]).map((c) => [c.itemId, c._sum.quantity ?? 0]));
    for (const item of items) {
      const free =
        item.type === ItemType.ASSET
          ? (units.get(item.id) ?? 0) - (assetClaimed.get(item.id) ?? 0)
          : roundQty(Number(item.quantity ?? 0) - (claimed.get(item.id) ?? 0));
      result.set(item.id, Math.max(0, free));
    }
    return result;
  }

  // ── Checkout ──────────────────────────────────────────────────────────────

  /** The caller's organization: the one they declared (verified by the actor service), else their only one. */
  private entityOf(actor: WarehouseActor): number | null {
    if (actor.declared) return actor.declared;
    return actor.home.entityIds.length === 1 ? actor.home.entityIds[0] : null;
  }

  private dayOf(value: string, refusal: string): Date {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(value ?? '').trim());
    const d = m ? new Date(`${m[1]}T00:00:00.000Z`) : new Date(NaN);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(refusal);
    return d;
  }

  private assertNotPast(day: Date) {
    const today = getYerevanDateKey(new Date());
    if (day.toISOString().slice(0, 10) < today) {
      throw new BadRequestException('Անհրաժեշտության ամսաթիվը չի կարող անցյալում լինել');
    }
  }

  async checkout(dto: CheckoutDto, userId: number, actor: WarehouseActor): Promise<SubmissionView> {
    const lines = (dto.lines ?? []).map((l) => ({ itemId: Number(l.itemId), quantity: roundQty(Number(l.quantity)) }));
    const newItems = dto.newItems ?? [];
    if (!lines.length && !newItems.length) {
      throw new BadRequestException('Զամբյուղը դատարկ է — ավելացրեք գոնե մեկ ապրանք');
    }
    for (const l of [...lines, ...newItems]) {
      if (!(Number(l.quantity) > 0)) throw new BadRequestException('Քանակը պետք է լինի դրական թիվ');
    }
    const purpose = dto.purpose.trim();
    if (!purpose) throw new BadRequestException('Նշեք, թե ինչու է անհրաժեշտ');
    const neededBy = this.dayOf(dto.neededBy, 'Նշեք, թե երբ է անհրաժեշտ');
    this.assertNotPast(neededBy);
    const entityId = this.entityOf(actor);

    // The same item twice in a cart is one ask.
    const merged = new Map<number, number>();
    for (const l of lines) merged.set(l.itemId, roundQty((merged.get(l.itemId) ?? 0) + l.quantity));
    const itemIds = [...merged.keys()];
    const items = itemIds.length
      ? await this.prisma.item.findMany({
          where: { id: { in: itemIds } },
          include: { variants: { select: { id: true } } },
        })
      : [];
    const itemOf = new Map(items.map((i) => [i.id, i]));
    for (const id of itemIds) {
      const item = itemOf.get(id);
      if (!item) throw new NotFoundException(`Ապրանքը չի գտնվել (#${id})`);
      if (item.variants.length) throw new BadRequestException(`«${item.name}» — ընտրեք ապրանքի տարբերակը`);
    }
    const free = await this.freeStock(itemIds);
    const split = splitCheckout(
      [...merged].map(([itemId, quantity]) => ({ itemId, quantity })),
      (id) => {
        const item = itemOf.get(id);
        return item ? { stockingMode: item.stockingMode, availability: availabilityOf(item.stockingMode, free.get(id) ?? 0) } : undefined;
      },
    );
    const purchaseLines: LineInput[] = [
      ...split.purchase.map((l) => {
        const item = itemOf.get(l.itemId)!;
        return {
          itemId: item.id,
          itemName: item.variantLabel ? `${item.name} — ${item.variantLabel}` : item.name,
          code: item.code ?? null,
          unit: (item.unit as string | null) ?? null,
          quantity: l.quantity,
        };
      }),
      ...newItems.map((n) => ({
        itemName: n.brandModel?.trim() ? `${n.name.trim()} (${n.brandModel.trim()})` : n.name.trim(),
        quantity: roundQty(Number(n.quantity)),
        note: [n.description?.trim(), n.link?.trim()].filter(Boolean).join('\n') || null,
      })),
    ];
    if (purchaseLines.length && !entityId) {
      throw new BadRequestException('Ընտրեք կազմակերպությունը, որի անունից ներկայացնում եք հարցումը');
    }

    const number = await this.nextNumber();
    const sub = await this.prisma.catalogSubmission.create({
      data: {
        number,
        createdBy: userId,
        entityId,
        projectId: dto.projectId ?? null,
        projectName: dto.projectName?.trim() || null,
        costCenter: dto.costCenter?.trim() || null,
        purpose,
        neededBy,
        comment: dto.comment?.trim() || null,
      },
    });
    const made: number[] = [];
    try {
      if (split.stock.length) {
        const { created } = await this.reservations.createForCatalog({
          submissionId: sub.id,
          number,
          lines: split.stock,
          projectId: dto.projectId ?? null,
          projectName: dto.projectName?.trim() || null,
          entityId,
          purpose,
          neededBy,
          performedBy: userId,
          actor,
        });
        made.push(...created.map((c: any) => c.id));
      }
      if (purchaseLines.length) {
        await this.requisitions.create(
          {
            title: `Կատալոգ · ${number}`,
            comment: dto.comment?.trim() ? `${purpose}\n${dto.comment.trim()}` : purpose,
            periodEnd: neededBy.toISOString().slice(0, 10),
            lines: purchaseLines,
          },
          userId,
          entityId,
          undefined,
          { catalog: { submissionId: sub.id } },
        );
      }
    } catch (e) {
      // Nothing half-made stays: the rows this call made are withdrawn and
      // the number is simply spent.
      this.logger.warn(`Checkout ${number} failed after writing: ${(e as Error)?.message}`);
      await this.prisma.resourceReservation.deleteMany({ where: { id: { in: made } } }).catch(() => undefined);
      await this.prisma.purchaseRequisition.deleteMany({ where: { submissionId: sub.id } }).catch(() => undefined);
      await this.prisma.catalogSubmission.delete({ where: { id: sub.id } }).catch(() => undefined);
      throw e;
    }
    return this.getOne(sub.id, actor);
  }

  private async nextNumber(): Promise<string> {
    const rows = await this.prisma.$queryRaw<{ nextval: bigint | number }[]>`SELECT nextval('"CatalogSubmission_number_seq"') AS nextval`;
    return formatSubmissionNumber(rows[0].nextval);
  }

  async addAttachment(id: number, userId: number, file: Express.Multer.File | undefined, actor: WarehouseActor) {
    const loaded = await this.loadOne(id);
    if (loaded.sub.createdBy !== userId) throw new ForbiddenException('Ֆայլ կարող է կցել միայն հարցումը ներկայացնողը');
    if (!file) throw new BadRequestException('Ֆայլը բացակայում է');
    const url = this.fileService.upload(file, 'attachment');
    await this.prisma.catalogSubmission.update({ where: { id }, data: { attachmentUrl: url } });
    if (loaded.requisition) {
      // Procurement reads the requisition, so the file travels with it too.
      await this.prisma.purchaseRequisitionAttachment.create({
        data: {
          requisitionId: loaded.requisition.id,
          uploadedBy: userId,
          name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
          url,
          size: file.size,
          mimeType: file.mimetype,
        },
      });
    }
    return this.getOne(id, actor);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  isQueueViewer(actor: WarehouseActor): boolean {
    const names = actor.permissionNames ?? [];
    return actor.isSuperAdmin || names.includes(QUEUE_PERMISSION) || names.includes('manage_warehouse');
  }

  async getOne(id: number, actor: WarehouseActor): Promise<SubmissionView> {
    const [view] = await this.views({ id }, actor.userId);
    if (!view) throw new NotFoundException('Հարցումը չի գտնվել');
    if (view.createdBy !== actor.userId && !this.isQueueViewer(actor)) {
      throw new ForbiddenException('Դուք այս հարցման հասանելիություն չունեք');
    }
    return view;
  }

  async mine(userId: number, query: Record<string, string | undefined>) {
    const all = await this.views({ createdBy: userId }, userId);
    return this.pageOf(this.filterViews(all, query), query);
  }

  /** The admin queue («Կատալոգի հարցումներ»): every submission, filtered as the design filters. */
  async queue(query: Record<string, string | undefined>, actor: WarehouseActor) {
    const where: any = {};
    if (Number(query.entityId) > 0) where.entityId = Number(query.entityId);
    if (Number(query.requesterId) > 0) where.createdBy = Number(query.requesterId);
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: this.dayOf(query.from, 'Ամսաթիվը սխալ է') } : {}),
        ...(query.to ? { lt: new Date(this.dayOf(query.to, 'Ամսաթիվը սխալ է').getTime() + 86_400_000) } : {}),
      };
    }
    let all = await this.views(where, actor.userId);
    if (Number(query.unitId) > 0) {
      const dir = await this.directory();
      all = all.filter((v) => dir.unitOf.get(v.createdBy)?.unitId === Number(query.unitId));
    }
    if (query.sort === 'oldest') all = [...all].reverse();
    return this.pageOf(this.filterViews(all, query), query);
  }

  private filterViews(all: SubmissionView[], query: Record<string, string | undefined>) {
    let out = all;
    const status = query.status?.trim().toUpperCase();
    if (status && (SUBMISSION_STATUSES as string[]).includes(status)) out = out.filter((v) => v.status === status);
    const kind = query.kind?.trim().toUpperCase();
    if (kind && ['STOCK', 'PURCHASE', 'NEW'].includes(kind)) out = out.filter((v) => v.lines.some((l) => l.kind === kind));
    const q = query.q?.trim().toLowerCase();
    if (q) {
      out = out.filter((v) =>
        [v.number, v.purpose, v.projectName, v.costCenter, `${v.requester.firstName} ${v.requester.lastName}`, ...v.lines.map((l) => l.itemName)]
          .filter(Boolean)
          .some((s) => String(s).toLowerCase().includes(q)),
      );
    }
    return out;
  }

  private pageOf(all: SubmissionView[], query: Record<string, string | undefined>) {
    const page = Math.max(1, Number(query.page ?? 1) || 1);
    return { items: all.slice((page - 1) * PAGE, page * PAGE), total: all.length };
  }

  private async loadOne(id: number): Promise<Loaded> {
    const [loaded] = await this.load({ id });
    if (!loaded) throw new NotFoundException('Հարցումը չի գտնվել');
    return loaded;
  }

  private async load(where: any): Promise<Loaded[]> {
    const subs = await this.prisma.catalogSubmission.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    if (!subs.length) return [];
    const ids = subs.map((s) => s.id);
    const [reservations, requisitions] = await Promise.all([
      this.prisma.resourceReservation.findMany({
        where: { submissionId: { in: ids } },
        include: {
          item: { select: { id: true, name: true, unit: true, code: true, variantLabel: true, type: true } },
          allocations: { where: { releasedAt: null }, select: { quantity: true } },
          statusHistory: { orderBy: { performedAt: 'asc' } },
        },
        orderBy: { id: 'asc' },
      }),
      this.prisma.purchaseRequisition.findMany({
        where: { submissionId: { in: ids } },
        include: {
          lines: { include: { item: { select: { id: true, name: true, unit: true, code: true, variantLabel: true } } }, orderBy: { id: 'asc' } },
          comments: { orderBy: { createdAt: 'asc' } },
        },
        orderBy: { id: 'asc' },
      }),
    ]);
    const resOf = new Map<number, any[]>();
    for (const r of reservations) {
      if (!resOf.has(r.submissionId!)) resOf.set(r.submissionId!, []);
      resOf.get(r.submissionId!)!.push(r);
    }
    const reqOf = new Map<number, any>();
    for (const r of requisitions) if (!reqOf.has(r.submissionId!)) reqOf.set(r.submissionId!, r);
    return subs.map((sub) => ({ sub, reservations: resOf.get(sub.id) ?? [], requisition: reqOf.get(sub.id) ?? null }));
  }

  private async views(where: any, viewerId: number): Promise<SubmissionView[]> {
    const loaded = await this.load(where);
    if (!loaded.length) return [];
    const itemIds = loaded.flatMap((l) => [
      ...l.reservations.map((r) => r.itemId),
      ...((l.requisition?.lines ?? []) as any[]).map((x) => x.itemId).filter((x) => x != null),
    ]);
    const userIds = loaded.flatMap((l) => [
      l.sub.createdBy,
      l.sub.infoRequestBy,
      l.requisition?.decidedBy,
      l.requisition?.reviewedBy,
      l.requisition?.rejectionRequestedBy,
      ...((l.requisition?.comments ?? []) as any[]).map((c) => c.userId),
      ...l.reservations.flatMap((r) => (r.statusHistory as any[]).map((h) => h.performedBy)),
    ]);
    const [free, users, dir] = await Promise.all([
      this.freeStock(itemIds),
      this.usersPrisma.getUsersByIds([...new Set(userIds.filter((x): x is number => typeof x === 'number'))]),
      this.directory(),
    ]);
    const userOf = new Map(users.map((u) => [u.id, u]));
    const person = (id: number | null | undefined): Person => {
      if (id == null) return null;
      const u = userOf.get(id);
      return { id, name: u ? `${u.firstName} ${u.lastName}`.trim() : `#${id}` };
    };
    return loaded.map((l) => this.toView(l, { free, userOf, person, dir, viewerId }));
  }

  private lineOfReservation(r: any, free: Map<number, number>): SubmissionLine {
    const issued = roundQty((r.allocations ?? []).reduce((s: number, a: any) => s + (a.quantity ?? 0), 0));
    const stage = stageOf('STOCK', r.status, { issued });
    return {
      id: lineIdOf('STOCK', r.id),
      kind: 'STOCK',
      itemId: r.itemId,
      itemName: r.item?.name ?? `#${r.itemId}`,
      variantLabel: r.item?.variantLabel ?? null,
      code: r.item?.code ?? null,
      unit: r.item?.unit ?? null,
      quantity: r.quantity,
      approvedQuantity: stage === 'REJECTED' ? 0 : stage === 'PENDING' || stage === 'CANCELLED' ? null : r.quantity,
      inStock: free.get(r.itemId) ?? 0,
      status: r.status,
      statusLabel: reservationStatusLabel(r.status),
      reservationId: r.id,
      requisitionId: null,
      requisitionLineId: null,
      stage,
    };
  }

  private lineOfRequisition(req: any, line: any, free: Map<number, number>): SubmissionLine {
    const kind: LineKind = line.itemId ? 'PURCHASE' : 'NEW';
    const stage = stageOf(kind, req.status);
    return {
      id: lineIdOf(kind, line.id),
      kind,
      itemId: line.itemId ?? null,
      itemName: line.itemName,
      variantLabel: line.item?.variantLabel ?? null,
      code: line.code ?? line.item?.code ?? null,
      unit: line.unit ?? line.item?.unit ?? null,
      quantity: line.quantity,
      approvedQuantity: stage === 'REJECTED' ? 0 : stage === 'PENDING' || stage === 'CANCELLED' ? null : line.quantity,
      inStock: line.itemId ? free.get(line.itemId) ?? 0 : null,
      status: req.status,
      statusLabel: REQUISITION_LABELS[req.status] ?? req.status,
      reservationId: null,
      requisitionId: req.id,
      requisitionLineId: line.id,
      stage,
    };
  }

  private linesOf(l: Loaded, free: Map<number, number>): SubmissionLine[] {
    return [
      ...l.reservations.map((r) => this.lineOfReservation(r, free)),
      ...((l.requisition?.lines ?? []) as any[]).map((line) => this.lineOfRequisition(l.requisition, line, free)),
    ];
  }

  private toView(
    l: Loaded,
    ctx: { free: Map<number, number>; userOf: Map<number, any>; person: (id: number | null | undefined) => Person; dir: Directory; viewerId: number },
  ): SubmissionView {
    const { sub, requisition } = l;
    const lines = this.linesOf(l, ctx.free);
    const stages = lines.map((x) => x.stage);
    const cancelled = !!sub.cancelledAt;
    const infoOpen = !!sub.infoRequestAt;
    const status = deriveStatus(stages, { cancelled, infoOpen });
    const editable = sub.createdBy === ctx.viewerId && stillEditable(stages, { cancelled });
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

    const timeline: SubmissionView['timeline'] = [
      { at: iso(sub.createdAt)!, kind: 'submitted', by: ctx.person(sub.createdBy), text: `Հարցումն ուղարկվել է (${sub.number})` },
    ];
    for (const r of l.reservations) {
      for (const h of r.statusHistory as any[]) {
        if (h.fromStatus == null) continue; // the row's creation is the submission's own event above
        const label = `${r.item?.name ?? `#${r.itemId}`}${r.item?.variantLabel ? ` (${r.item.variantLabel})` : ''}`;
        const quantityNote =
          h.previousQuantity != null && h.newQuantity != null && h.previousQuantity !== h.newQuantity
            ? ` — քանակը ${h.previousQuantity} → ${h.newQuantity}`
            : '';
        const text = h.fromStatus === h.toStatus
          ? `${label}: ${h.reason ?? 'նշում'}${quantityNote}`
          : `${label}: ${reservationStatusLabel(h.toStatus)}${h.reason ? ` — ${h.reason}` : ''}${quantityNote}`;
        timeline.push({ at: iso(h.performedAt)!, kind: `reservation.${h.toStatus}`, by: ctx.person(h.performedBy), text });
      }
    }
    if (requisition) {
      for (const c of requisition.comments as any[]) {
        timeline.push({ at: iso(c.createdAt)!, kind: 'comment', by: ctx.person(c.userId), text: c.text });
      }
      if (requisition.decidedAt) {
        const rejectedByOrg = ['REJECTED', 'REJECTION_PENDING'].includes(requisition.status) && !requisition.reviewedBy;
        timeline.push({
          at: iso(requisition.decidedAt)!,
          kind: rejectedByOrg ? 'requisition.rejected' : 'requisition.approved',
          by: ctx.person(requisition.decidedBy),
          text: rejectedByOrg ? 'Գնման տողերը մերժվել են' : 'Գնման տողերը հաստատվել են և փոխանցվել գնումների բաժին',
        });
      }
      if (requisition.rejectionRequestedAt) {
        timeline.push({
          at: iso(requisition.rejectionRequestedAt)!,
          kind: 'requisition.rejection_requested',
          by: ctx.person(requisition.rejectionRequestedBy),
          text: `Գնման տողերը մերժվել են${requisition.rejectionReason ? ` — ${requisition.rejectionReason}` : ''}`,
        });
      }
      if (requisition.reviewedAt && requisition.status === 'APPROVED') {
        timeline.push({ at: iso(requisition.reviewedAt)!, kind: 'requisition.ordered', by: ctx.person(requisition.reviewedBy), text: 'Գնումների բաժինը պատվեր է ձևակերպել' });
      }
    }
    if (sub.infoRequestAt) {
      timeline.push({ at: iso(sub.infoRequestAt)!, kind: 'info_request', by: ctx.person(sub.infoRequestBy), text: sub.infoRequestText ?? '' });
    }
    if (sub.cancelledAt) {
      timeline.push({ at: iso(sub.cancelledAt)!, kind: 'cancelled', by: ctx.person(sub.createdBy), text: 'Հարցումը չեղարկվել է' });
    }
    timeline.sort((a, b) => a.at.localeCompare(b.at));

    // Who decided: the organization's approver on the requisition, else the
    // warehouse person who last acted on a stock line.
    let approver: Person = requisition?.decidedBy ? ctx.person(requisition.decidedBy) : null;
    if (!approver) {
      for (const r of l.reservations) {
        for (const h of [...(r.statusHistory as any[])].reverse()) {
          if (h.performedBy && h.performedBy !== sub.createdBy && ['PARTIALLY_ALLOCATED', 'ALLOCATED', 'REJECTED', 'APPROVED'].includes(h.toStatus)) {
            approver = ctx.person(h.performedBy);
            break;
          }
        }
        if (approver) break;
      }
    }

    const requesterUser = ctx.userOf.get(sub.createdBy);
    const unit = ctx.dir.unitOf.get(sub.createdBy) ?? null;
    const entityName = (sub.entityId && ctx.dir.entityName.get(sub.entityId)) || (unit && ctx.dir.entityName.get(unit.entityId)) || null;

    return {
      id: sub.id,
      number: sub.number,
      createdAt: iso(sub.createdAt)!,
      createdBy: sub.createdBy,
      requester: {
        id: sub.createdBy,
        firstName: requesterUser?.firstName ?? '',
        lastName: requesterUser?.lastName ?? '',
        unitName: unit?.unitName ?? null,
        entityName,
      },
      entityId: sub.entityId ?? null,
      projectId: sub.projectId ?? null,
      projectName: sub.projectName ?? null,
      costCenter: sub.costCenter ?? null,
      purpose: sub.purpose,
      neededBy: new Date(sub.neededBy).toISOString().slice(0, 10),
      comment: sub.comment ?? null,
      attachmentUrl: sub.attachmentUrl ?? null,
      status,
      progress: progressOf(stages),
      canEdit: editable,
      canCancel: editable,
      lines: lines.map(({ stage: _stage, ...rest }) => rest),
      timeline,
      infoRequest: sub.infoRequestAt
        ? { at: iso(sub.infoRequestAt)!, by: ctx.person(sub.infoRequestBy), text: sub.infoRequestText ?? '' }
        : null,
      approver,
    };
  }

  /**
   * Unit and organization names from HR — the forest every entity's tree is
   * read from, and the organization directory the procurement form uses —
   * with the internal secret, as entities.controller.ts asks HR. Unreachable
   * means blank names, never a failed list.
   */
  private directory(): Promise<Directory> {
    const cached = this.directoryCache;
    if (cached && Date.now() - cached.at < CatalogService.DIRECTORY_FRESH_MS) return cached.value;
    const value = this.readDirectory();
    this.directoryCache = { at: Date.now(), value };
    return value;
  }

  private async readDirectory(): Promise<Directory> {
    const empty: Directory = { unitOf: new Map(), entityName: new Map() };
    const hrUrl = process.env.HR_SERVICE_URL || 'http://localhost:3001';
    let secret: string;
    try {
      secret = requireInternalSecret();
    } catch (e) {
      this.logger.warn((e as Error).message);
      return empty;
    }
    const headers = { 'x-internal-secret': secret };
    try {
      const [treeRes, entRes] = await Promise.all([
        fetch(`${hrUrl}/api/org-units/tree/internal`, { headers, signal: AbortSignal.timeout(5000) }),
        fetch(`${hrUrl}/api/entities/internal/all`, { headers, signal: AbortSignal.timeout(5000) }),
      ]);
      const dir: Directory = { unitOf: new Map(), entityName: new Map() };
      if (entRes.ok) {
        for (const e of ((await entRes.json()) as any[]) ?? []) {
          if (Number(e?.id) > 0) dir.entityName.set(Number(e.id), String(e.name ?? ''));
        }
      }
      if (treeRes.ok) {
        const walk = (nodes: any[]) => {
          for (const n of nodes ?? []) {
            const place = { unitId: Number(n.id), unitName: String(n.name ?? ''), entityId: Number(n.entityId) };
            for (const p of [n.head, ...(n.members ?? [])]) {
              const id = Number(p?.id);
              if (id > 0 && !dir.unitOf.has(id)) dir.unitOf.set(id, place);
            }
            walk(n.children ?? []);
          }
        };
        walk((await treeRes.json()) as any[]);
      }
      return dir;
    } catch (e) {
      this.logger.warn(`HR directory lookup failed: ${(e as Error)?.message}`);
      return empty;
    }
  }

  // ── Requester actions ─────────────────────────────────────────────────────

  private async ownEditable(id: number, userId: number, refusal: string): Promise<{ loaded: Loaded; lines: SubmissionLine[] }> {
    const loaded = await this.loadOne(id);
    if (loaded.sub.createdBy !== userId) throw new ForbiddenException(refusal);
    const lines = this.linesOf(loaded, new Map());
    if (!stillEditable(lines.map((x) => x.stage), { cancelled: !!loaded.sub.cancelledAt })) {
      throw new BadRequestException('Հարցումն արդեն հաստատման փուլում է և այլևս չի կարող փոխվել');
    }
    return { loaded, lines };
  }

  /** The requester's note on a reservation: a history row that changes nothing but says something. */
  private async noteOnReservation(r: any, performedBy: number, reason: string, quantities?: { previousQuantity: number; newQuantity: number }) {
    await this.prisma.reservationStatusHistory.create({
      data: {
        reservationId: r.id,
        fromStatus: r.status,
        toStatus: r.status,
        performedBy,
        reason,
        ...(quantities ?? {}),
      },
    });
  }

  async edit(id: number, dto: EditSubmissionDto, userId: number, actor: WarehouseActor): Promise<SubmissionView> {
    const { loaded, lines } = await this.ownEditable(id, userId, 'Հարցումը կարող է խմբագրել միայն ներկայացնողը');
    const byId = new Map(lines.map((x) => [x.id, x]));
    for (const edit of dto.lines ?? []) {
      const line = byId.get(edit.id);
      const ref = parseLineId(edit.id);
      if (!line || !ref) throw new NotFoundException('Տողը չի գտնվել');
      const quantity = roundQty(Number(edit.quantity));
      if (!(quantity > 0)) throw new BadRequestException('Քանակը պետք է լինի դրական թիվ');
      if (ref.table === 'reservation') {
        const r = loaded.reservations.find((x) => x.id === ref.rowId)!;
        if (r.item?.type === ItemType.ASSET && !Number.isInteger(quantity)) {
          throw new BadRequestException('Ակտիվների քանակը պետք է լինի ամբողջ թիվ');
        }
        if (quantity === r.quantity) continue;
        await this.prisma.resourceReservation.update({ where: { id: r.id }, data: { quantity } });
        await this.noteOnReservation(r, userId, 'Քանակը փոխվել է ներկայացնողի կողմից', { previousQuantity: r.quantity, newQuantity: quantity });
      } else {
        await this.prisma.purchaseRequisitionLine.update({ where: { id: ref.rowId }, data: { quantity } });
      }
    }
    const data: any = {};
    if (dto.purpose !== undefined) data.purpose = dto.purpose.trim();
    if (dto.comment !== undefined) data.comment = dto.comment.trim() || null;
    if (dto.neededBy !== undefined) {
      const day = this.dayOf(dto.neededBy, 'Ամսաթիվը սխալ է');
      this.assertNotPast(day);
      data.neededBy = day;
    }
    if (Object.keys(data).length) {
      await this.prisma.catalogSubmission.update({ where: { id }, data });
      if (data.purpose && loaded.reservations.length) {
        await this.prisma.resourceReservation.updateMany({ where: { submissionId: id }, data: { notes: data.purpose } });
      }
      if (loaded.requisition && (data.purpose || data.comment !== undefined || data.neededBy)) {
        const purpose = data.purpose ?? loaded.sub.purpose;
        const comment = data.comment !== undefined ? data.comment : loaded.sub.comment;
        await this.prisma.purchaseRequisition.update({
          where: { id: loaded.requisition.id },
          data: {
            comment: comment ? `${purpose}\n${comment}` : purpose,
            ...(data.neededBy ? { periodEnd: data.neededBy } : {}),
          },
        });
      }
    }
    return this.getOne(id, actor);
  }

  async cancel(id: number, userId: number, actor: WarehouseActor): Promise<SubmissionView> {
    const { loaded } = await this.ownEditable(id, userId, 'Հարցումը կարող է չեղարկել միայն ներկայացնողը');
    for (const r of loaded.reservations) {
      if (RESERVATION_LIVE.includes(r.status)) {
        await this.reservations.cancel(r.id, userId, 'Հարցումը չեղարկվել է ներկայացնողի կողմից', actor);
      }
    }
    if (loaded.requisition && REQUISITION_CANCELLABLE.includes(loaded.requisition.status)) {
      await this.requisitions.cancel(loaded.requisition.id, userId, actor.isSuperAdmin);
    }
    await this.prisma.catalogSubmission.update({
      where: { id },
      data: { cancelledAt: new Date(), infoRequestText: null, infoRequestBy: null, infoRequestAt: null },
    });
    return this.getOne(id, actor);
  }

  async reply(id: number, text: string, file: Express.Multer.File | undefined, userId: number, actor: WarehouseActor): Promise<SubmissionView> {
    const loaded = await this.loadOne(id);
    if (loaded.sub.createdBy !== userId) throw new ForbiddenException('Պատասխանել կարող է միայն հարցումը ներկայացնողը');
    if (!loaded.sub.infoRequestAt) throw new BadRequestException('Հարցումը տեղեկության սպասման մեջ չէ');
    const answer = text?.trim();
    if (!answer) throw new BadRequestException('Գրեք պատասխանը');
    const req = loaded.requisition;
    if (req) {
      await this.requisitions.addComment(req.id, userId, `Պատասխան՝ ${answer}`);
      if (file) await this.requisitions.addAttachment(req.id, userId, file);
      if (req.status === 'DRAFT') {
        await this.prisma.purchaseRequisition.update({ where: { id: req.id }, data: { status: 'PENDING_APPROVAL' } });
      }
    } else if (file) {
      const url = this.fileService.upload(file, 'attachment');
      await this.prisma.catalogSubmission.update({ where: { id }, data: { attachmentUrl: url } });
    }
    for (const r of loaded.reservations) {
      if (RESERVATION_LIVE.includes(r.status)) await this.noteOnReservation(r, userId, `Պատասխան՝ ${answer}`);
    }
    await this.prisma.catalogSubmission.update({
      where: { id },
      data: { infoRequestText: null, infoRequestBy: null, infoRequestAt: null },
    });
    return this.getOne(id, actor);
  }

  // ── Approver actions ──────────────────────────────────────────────────────

  /** D3: manage_reservations decides stock lines; approve_purchase_requisition in the requisition's organization decides purchases. */
  private async rightsOf(actor: WarehouseActor, loaded: Loaded): Promise<ApprovalRights> {
    const entityId = loaded.requisition?.entityId ?? loaded.sub.entityId ?? null;
    let holds = false;
    if (entityId && !actor.isSuperAdmin) {
      const info = await this.usersPrisma.getUserAccessInfo(actor.userId, entityId);
      holds = info.isSuperAdmin || info.permissionNames.includes(APPROVE_PERMISSION);
    }
    return approvalRights(actor, holds);
  }

  private assertDecidable(loaded: Loaded) {
    if (loaded.sub.cancelledAt) throw new BadRequestException('Հարցումը չեղարկված է');
  }

  /** A returned requisition (DRAFT) the approver acts on anyway goes back to the deciding state first. */
  private async reopenIfReturned(req: any) {
    if (req.status === 'DRAFT') {
      await this.prisma.purchaseRequisition.update({ where: { id: req.id }, data: { status: 'PENDING_APPROVAL' } });
      req.status = 'PENDING_APPROVAL';
    }
  }

  async approve(id: number, dto: ApproveSubmissionDto, userId: number, actor: WarehouseActor) {
    const loaded = await this.loadOne(id);
    this.assertDecidable(loaded);
    const rights = await this.rightsOf(actor, loaded);
    const lines = this.linesOf(loaded, new Map());
    const byId = new Map(lines.map((x) => [x.id, x]));
    const asked = dto.lines.map((d) => {
      const line = byId.get(d.id);
      if (!line) throw new NotFoundException(`Տողը չի գտնվել (${d.id})`);
      return { ...line, approvedQuantity: roundQty(Number(d.approvedQuantity)) };
    });
    const { allowed, skipped } = partitionByRights(asked, rights);
    if (!allowed.length) throw new ForbiddenException('Դուք այս հարցման տողերը հաստատելու թույլտվություն չունեք');
    const comment = dto.comment?.trim() || undefined;

    // Stock lines first: they can fail on the shelf, and a refused issuance
    // should not leave purchase lines approved behind it.
    for (const line of allowed.filter((x) => x.kind === 'STOCK')) {
      const r = loaded.reservations.find((x) => x.id === line.reservationId)!;
      if (!RESERVATION_LIVE.includes(r.status) || line.stage === 'READY') {
        throw new BadRequestException(`«${line.itemName}» — տողն արդեն «${reservationStatusLabel(r.status)}» կարգավիճակում է`);
      }
      if (line.approvedQuantity === 0) {
        await this.reservations.reject(r.id, userId, comment ?? 'Մերժված է հաստատողի կողմից', actor);
        continue;
      }
      if (line.approvedQuantity > r.quantity) {
        throw new BadRequestException(`«${line.itemName}» — հաստատվող քանակը (${line.approvedQuantity}) գերազանցում է պահանջվածը (${r.quantity})`);
      }
      if (r.item?.type === ItemType.ASSET && !Number.isInteger(line.approvedQuantity)) {
        throw new BadRequestException('Ակտիվների քանակը պետք է լինի ամբողջ թիվ');
      }
      if (line.approvedQuantity !== r.quantity) {
        await this.prisma.resourceReservation.update({ where: { id: r.id }, data: { quantity: line.approvedQuantity } });
        await this.noteOnReservation(r, userId, comment ?? 'Քանակը ճշգրտվել է հաստատման ժամանակ', {
          previousQuantity: r.quantity,
          newQuantity: line.approvedQuantity,
        });
      }
      if (r.item?.type === ItemType.ASSET) {
        // A unit is allocated on the Reservations page; here the request is let through.
        if (r.status === 'PENDING') {
          await this.prisma.$transaction([
            this.prisma.resourceReservation.update({ where: { id: r.id }, data: { status: 'APPROVED' } }),
            this.prisma.reservationStatusHistory.create({
              data: { reservationId: r.id, fromStatus: 'PENDING', toStatus: 'APPROVED', performedBy: userId, reason: comment ?? 'Հաստատված է կատալոգի հարցումների էջից' },
            }),
          ]);
        }
      } else {
        // The existing approval: everything still outstanding is issued.
        await this.reservations.approveConsumable(r.id, userId, undefined, actor);
      }
    }

    const purchase = allowed.filter((x) => x.kind !== 'STOCK');
    if (purchase.length) {
      const req = loaded.requisition;
      if (!req) throw new NotFoundException('Գնման հայտը չի գտնվել');
      await this.reopenIfReturned(req);
      if (req.status !== 'PENDING_APPROVAL') {
        throw new BadRequestException(`Գնման հայտն արդեն «${REQUISITION_LABELS[req.status] ?? req.status}» կարգավիճակում է`);
      }
      const declined = purchase.filter((x) => x.approvedQuantity === 0);
      const kept = purchase.filter((x) => x.approvedQuantity > 0);
      for (const line of kept) {
        if (line.approvedQuantity !== line.quantity) {
          await this.prisma.purchaseRequisitionLine.update({ where: { id: line.requisitionLineId! }, data: { quantity: line.approvedQuantity } });
        }
      }
      if (comment) await this.requisitions.addComment(req.id, userId, comment);
      const allLines = (req.lines as any[]).map((x) => x.id);
      const declinedIds = new Set(declined.map((x) => x.requisitionLineId!));
      if (allLines.every((lineId) => declinedIds.has(lineId))) {
        await this.requisitions.orgReject(req.id, userId, comment ?? 'Բոլոր տողերը մերժվել են հաստատողի կողմից');
      } else {
        if (declined.length) {
          await this.prisma.purchaseRequisitionLine.deleteMany({ where: { id: { in: [...declinedIds] } } });
          await this.requisitions.addComment(
            req.id,
            userId,
            `Մերժված տողեր՝ ${declined.map((x) => `${x.itemName} × ${x.quantity}`).join(', ')}`,
          );
        }
        await this.requisitions.orgApprove(req.id, userId);
      }
      // The approver has taken the open question over.
      if (loaded.sub.infoRequestAt) {
        await this.prisma.catalogSubmission.update({ where: { id }, data: { infoRequestText: null, infoRequestBy: null, infoRequestAt: null } });
      }
    }
    return { ...(await this.getOne(id, actor)), skipped };
  }

  async reject(id: number, reason: string, userId: number, actor: WarehouseActor) {
    const loaded = await this.loadOne(id);
    this.assertDecidable(loaded);
    const why = reason?.trim();
    if (!why) throw new BadRequestException('Մերժման պատճառը պարտադիր է');
    const rights = await this.rightsOf(actor, loaded);
    const lines = this.linesOf(loaded, new Map());
    const { allowed, skipped } = partitionByRights(lines, rights);
    if (!allowed.length) throw new ForbiddenException('Դուք այս հարցման տողերը մերժելու թույլտվություն չունեք');
    for (const line of allowed.filter((x) => x.kind === 'STOCK')) {
      const r = loaded.reservations.find((x) => x.id === line.reservationId)!;
      if (RESERVATION_LIVE.includes(r.status)) await this.reservations.reject(r.id, userId, why, actor);
    }
    if (allowed.some((x) => x.kind !== 'STOCK') && loaded.requisition) {
      const req = loaded.requisition;
      await this.reopenIfReturned(req);
      if (req.status === 'PENDING_APPROVAL') await this.requisitions.orgReject(req.id, userId, why);
      else throw new BadRequestException(`Գնման հայտն արդեն «${REQUISITION_LABELS[req.status] ?? req.status}» կարգավիճակում է`);
    }
    if (loaded.sub.infoRequestAt) {
      await this.prisma.catalogSubmission.update({ where: { id }, data: { infoRequestText: null, infoRequestBy: null, infoRequestAt: null } });
    }
    return { ...(await this.getOne(id, actor)), skipped };
  }

  /** «Պահանջել տեղեկություն»: the open question, the requisition back to DRAFT, a note on the reservations. */
  async requestInfo(id: number, text: string, userId: number, actor: WarehouseActor) {
    const loaded = await this.loadOne(id);
    this.assertDecidable(loaded);
    const question = text?.trim();
    if (!question) throw new BadRequestException('Գրեք, թե ինչ տեղեկություն է պետք');
    if (loaded.sub.infoRequestAt) throw new BadRequestException('Հարցումն արդեն տեղեկության սպասման մեջ է');
    const rights = await this.rightsOf(actor, loaded);
    const lines = this.linesOf(loaded, new Map());
    const { allowed, skipped } = partitionByRights(lines, rights);
    if (!allowed.length) throw new ForbiddenException('Դուք այս հարցման համար տեղեկություն պահանջելու թույլտվություն չունեք');
    if (!allowed.some((x) => x.stage === 'PENDING')) {
      throw new BadRequestException('Հարցման տողերն արդեն որոշված են — տեղեկություն պահանջել հնարավոր չէ');
    }
    for (const line of allowed.filter((x) => x.kind === 'STOCK')) {
      const r = loaded.reservations.find((x) => x.id === line.reservationId)!;
      if (RESERVATION_LIVE.includes(r.status)) await this.noteOnReservation(r, userId, `Պահանջվում է տեղեկություն՝ ${question}`);
    }
    if (allowed.some((x) => x.kind !== 'STOCK') && loaded.requisition) {
      const req = loaded.requisition;
      await this.requisitions.addComment(req.id, userId, `Պահանջվում է տեղեկություն՝ ${question}`);
      if (req.status === 'PENDING_APPROVAL') {
        await this.prisma.purchaseRequisition.update({ where: { id: req.id }, data: { status: 'DRAFT' } });
      }
    }
    await this.prisma.catalogSubmission.update({
      where: { id },
      data: { infoRequestText: question, infoRequestBy: userId, infoRequestAt: new Date() },
    });
    return { ...(await this.getOne(id, actor)), skipped };
  }
}
