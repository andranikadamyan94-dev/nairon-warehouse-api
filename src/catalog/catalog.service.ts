import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';
import { WAREHOUSE_TYPES, WarehouseNotification, WarehouseNotificationsService } from '../common/notifications/notifications.service';

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
import { CrmTaskCard, ReservationsService } from '../reservations/reservations.service';
import { isReservationReader } from '../reservations/two-party';
import { decideWorkspace } from '../auth/actor';
import { AssetsService } from '../assets/assets.service';
import { CrmObjectCard, ObjectsService, fetchCrmObjectCard } from '../objects/objects.service';
import { OBJECT_PAGE_RIGHT, holdsObjectRight, isResponsibleOf } from '../objects/object-page-rights';

import {
  ApprovalRights,
  Availability,
  LineKind,
  LineStage,
  SubmissionStatus,
  SUBMISSION_STATUSES,
  approvalRights,
  availabilityOf,
  availableForLine,
  deriveStatus,
  formatSubmissionNumber,
  lineIdOf,
  ownClaim,
  parseLineId,
  partitionByRights,
  progressOf,
  splitCheckout,
  stageOf,
  stillEditable,
  stockLineLabel,
  DIRECT_SUPPLY_PURPOSE,
  SUBMISSION_SOURCES,
  SubmissionSource,
  sourceOf,
} from './catalog.rules';
import { CheckoutDto } from './dto/checkout.dto';
import { ApproveSubmissionDto, EditSubmissionDto, IssueLineDto } from './dto/submission-actions.dto';

/** The queue's permission (D4). Granted per environment by the owner; auth-api seeds the name. */
export const QUEUE_PERMISSION = 'view_catalog_requests';
/**
 * Who opens the queue (owner 2026-10-08): «Հաստատում» is the one surface for
 * every request — the catalog desk AND the keepers (the former «Տրամադրում»
 * tab's rights, the alert holders included, so a notice's link opens). What
 * each may DO inside is decided per action: manage_reservations hands out,
 * approve_purchase_requisition decides purchase lines, the desk reminds.
 */
export const QUEUE_VIEWER_PERMISSIONS = [QUEUE_PERMISSION, 'view_reservations', 'manage_reservations', 'receive_reservation_alerts'];
/** Ordering from the catalog: the right that opens the warehouse app is enough (2026-10-08). */
export const EMPLOYEE_PERMISSIONS = ['page_warehouse', 'view_warehouse'];

const PAGE = 20;

/** One reminder per request per hour. */
export const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

/** HH:mm in Yerevan — what the refusal names. */
export function yerevanClock(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Yerevan', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

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
  /** What the shelf offers this line — the free count plus the line's own claim (REQ-1015). */
  inStock: number | null;
  /** Asset lines go out unit by unit: approving one picks the units (2026-10-07). */
  isAsset: boolean;
  /** Issued so far — for an asset line, the units already allocated. */
  issuedQuantity: number;
  /** Confirmed received so far («Ստացել եմ»); what is still owed is issued − accepted (2026-10-08). */
  acceptedQuantity: number;
  status: string;
  statusLabel: string;
  reservationId: number | null;
  requisitionId: number | null;
  requisitionLineId: number | null;
  /**
   * The keeper's view of a stock line (2026-10-08, the queue is the one
   * surface): the pool it draws from (null = main), what is free there FOR
   * THIS LINE, what is still to hand out, what went out and is not yet
   * confirmed («Հետ վերցնել»'s window), the live allocations («Վերադարձնել»),
   * the two histories, and the purchase requisition raised for a short line.
   * Purchase/new lines carry the empty shape.
   */
  warehouse: { id: number; name: string } | null;
  freeQuantity: number;
  outstandingQuantity: number;
  reclaimableQuantity: number;
  allocations: { id: number; assetId: number | null; serialNumber: string | null; quantity: number }[];
  allocationHistory: { at: string; action: string; by: Person; serialNumber: string | null; notes: string | null }[];
  statusHistory: { at: string; from: string | null; to: string; by: Person; reason: string | null; previousQuantity: number | null; newQuantity: number | null }[];
  requisition: { id: number; status: string } | null;
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
  /** Object requests (2026-10-08): the construction object this was filed for, with its label when CRM answers. */
  objectId: number | null;
  object: { id: number; code: string | null; name: string | null } | null;
  /** Task requests (2026-10-08): the CRM task this was filed for, with its title and project when CRM answers. */
  taskId: number | null;
  task: { id: number; title: string | null; projectId: number | null } | null;
  /** The warehouse supplied the object without a request («Պահեստից՝ առանց հայտի»): the keeper filed it, lines issued at once. */
  direct: boolean;
  /** Where it came from — the queue's «Աղբյուր» filter (2026-10-08): CATALOG / OBJECT / TASK / DIRECT. */
  source: SubmissionSource;
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
  /** «Հիշեցնել աշխատակցին» (2026-10-07): the last reminder and when the next one is allowed. */
  reminder: { lastAt: string; by: Person; nextAt: string } | null;
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
    @Optional() private readonly notifications?: WarehouseNotificationsService,
    /** The Reservations page's free-unit list, reused for the asset unit picker (REQ-1015). */
    @Optional() private readonly assets?: AssetsService,
    /** CRM's object catalogue (cached), for the cart's object picker and the rows' labels (2026-10-08). */
    @Optional() private readonly objects?: ObjectsService,
  ) {}

  // ── Notifications (phase 2, 2026-10-06) ───────────────────────────────────
  //
  // The catalog speaks for its rows: the desk (view_catalog_requests in the
  // submission's organisation) hears of a checkout and a reply; the submitter
  // hears every decision once per action — approved, rejected, information
  // requested, ready to collect. The reservation and requisition calls made
  // on the way are quiet so nobody hears the same act twice.

  private notify(n: WarehouseNotification) {
    if (this.notifications) void this.notifications.send(n);
  }

  /** The desk hears of a new checkout, shortage included; the purchase approvers of a requisition it raised too — once. */
  private announceCheckout(
    sub: { id: number; number: string; entityId: number | null; createdBy: number; purpose: string; projectName: string | null },
    stock: { itemName?: string; quantity: number; status: string }[],
    purchase: { itemName: string; quantity: number }[],
    requisition: any | null,
    object: CrmObjectCard | null = null,
    task: CrmTaskCard | null = null,
  ) {
    if (!this.notifications) return;
    void (async () => {
      const short = stock.filter((c) => c.status === 'PENDING');
      const lines = [...stock, ...purchase].map((l) => `${l.itemName} × ${l.quantity}`).join(', ');
      await this.notifications!.send({
        type: WAREHOUSE_TYPES.catalogRequestReceived,
        permissions: [QUEUE_PERMISSION],
        entityIds: [sub.entityId],
        actorId: sub.createdBy,
        title: task ? 'Նոր հարցում առաջադրանքից' : object ? 'Նոր հարցում օբյեկտից' : 'Նոր հարցում կատալոգից',
        body: `Հարցում ${sub.number}${task ? ` (առաջադրանք #${task.id})` : object ? ` (${object.name})` : ''}՝ ${lines}${short.length ? `։ Պաշարը չի բավարարում՝ ${short.map((c) => c.itemName).join(', ')}` : ''}։`,
        path: `/goods-requests?tab=approve&id=${sub.id}`,
        details: [
          { label: 'Հարցում', value: sub.number },
          ...(task ? [{ label: 'Առաջադրանք', value: `#${task.id} ${task.title}`.trim() }] : []),
          ...(object ? [{ label: 'Օբյեկտ', value: object.name }] : []),
          { label: 'Նպատակ', value: sub.purpose },
          { label: 'Ապրանքներ', value: lines },
          ...(short.length ? [{ label: 'Պաշարը չի բավարարում', value: short.map((c) => `${c.itemName} × ${c.quantity}`).join(', ') }] : []),
          ...(sub.projectName ? [{ label: 'Նախագիծ', value: sub.projectName }] : []),
        ],
      });
      if (requisition) {
        const told = await this.notifications!.audience([QUEUE_PERMISSION], [sub.entityId]);
        this.requisitions.announceSubmitted(requisition, sub.createdBy, told);
      }
    })().catch((e) => this.logger.warn(`checkout notification failed: ${e?.message ?? e}`));
  }

  /** The submitter hears what the desk did — one notice per decision. */
  private async announceToSubmitter(
    id: number,
    actor: WarehouseActor,
    n: { kind: 'approved' | 'rejected' | 'info'; text?: string },
  ) {
    try {
      if (!this.notifications) return;
      const view = await this.getOne(id, actor);
      const ready = n.kind === 'approved' && view.status === 'READY';
      const title = ready
        ? 'Հարցումը պատրաստ է ստանալու'
        : n.kind === 'approved' ? 'Հարցումը հաստատվել է'
        : n.kind === 'rejected' ? 'Հարցումը մերժվել է'
        : 'Հարցման համար տեղեկություն է պահանջվում';
      const body = ready
        ? `Հարցում ${view.number}՝ ապրանքները պատրաստ են, ստացեք պահեստից և հաստատեք ստացումը։`
        : n.kind === 'approved' ? `Հարցում ${view.number}՝ հաստատվել է${n.text ? `․ ${n.text}` : ''}։`
        : n.kind === 'rejected' ? `Հարցում ${view.number}՝ մերժվել է${n.text ? `՝ ${n.text}` : ''}։`
        : `Հարցում ${view.number}՝ հաստատողը տեղեկություն է խնդրում՝ ${n.text ?? ''}`;
      this.notify({
        type: ready ? WAREHOUSE_TYPES.catalogReady : WAREHOUSE_TYPES.catalogRequestDecided,
        userIds: [view.createdBy],
        actorId: actor.userId,
        title,
        body,
        path: `/goods-requests?tab=mine&id=${id}`,
        details: [
          { label: 'Հարցում', value: view.number },
          ...(n.text ? [{ label: n.kind === 'info' ? 'Հարց' : n.kind === 'rejected' ? 'Պատճառ' : 'Մեկնաբանություն', value: n.text }] : []),
        ],
      });
    } catch (e: any) {
      this.logger.warn(`catalog decision notification failed: ${e?.message ?? e}`);
    }
  }

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
  private async freeStock(itemIds: number[], opts: { raw?: boolean } = {}): Promise<Map<number, number>> {
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
        ? this.prisma.asset.groupBy({
            by: ['itemId'],
            // Only units that can actually be handed out — the same rule as the
            // unit picker / Reservations page (a responsible person on record),
            // so «պահեստում կա» and the picker always agree (owner 2026-10-07).
            where: {
              itemId: { in: assetIds },
              status: 'AVAILABLE',
              warehouseId: null,
              custodies: { some: { releasedAt: null, holderType: 'USER' } },
            },
            _count: { id: true },
          })
        : [],
      assetIds.length
        ? this.prisma.resourceReservation.groupBy({
            by: ['itemId'],
            where: { itemId: { in: assetIds }, warehouseId: null, status: { in: ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'] }, ...current },
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
      // raw: a request page adds each line's own claim back before clamping (REQ-1015).
      result.set(item.id, opts.raw ? free : Math.max(0, free));
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

    // Task requests (2026-10-08): the task decides the project AND the object;
    // CRM's card decides who may ask. A project or object that disagrees with
    // the task's is refused before anything is written.
    const task = dto.taskId != null ? await this.taskForCheckout(Number(dto.taskId), actor) : null;
    if (task && dto.projectId != null && task.projectId != null && Number(dto.projectId) !== task.projectId) {
      throw new BadRequestException('Նախագիծը չի համընկնում առաջադրանքի նախագծի հետ');
    }
    if (task && dto.objectId != null && task.objectId != null && Number(dto.objectId) !== task.objectId) {
      throw new BadRequestException('Օբյեկտը չի համընկնում առաջադրանքի օբյեկտի հետ');
    }
    const taskProjectName = task?.projectId ? ((await this.crmProjectNames()).get(task.projectId) ?? dto.projectName?.trim() ?? null) : null;
    // Object requests (2026-10-08): the object decides the project; CRM's card decides who may ask.
    // A task's object is the task's own (no responsible-person rule): it rides on the task.
    const object = !task && dto.objectId != null ? await this.objectForCheckout(Number(dto.objectId), actor) : null;
    if (object && dto.projectId != null && object.projectId != null && Number(dto.projectId) !== object.projectId) {
      throw new BadRequestException('Նախագիծը չի համընկնում օբյեկտի նախագծի հետ');
    }
    const projectId = task ? task.projectId : object ? object.projectId : (dto.projectId ?? null);
    const projectName = task ? taskProjectName : object ? object.projectName : (dto.projectName?.trim() || null);

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
        projectId,
        projectName,
        costCenter: dto.costCenter?.trim() || null,
        objectId: task ? (task.objectId ?? null) : object ? object.id : null,
        taskId: task ? task.id : null,
        purpose,
        neededBy,
        comment: dto.comment?.trim() || null,
      } as any,
    });
    const made: number[] = [];
    const madeStock: { itemName?: string; quantity: number; status: string }[] = [];
    let requisition: any = null;
    try {
      if (split.stock.length) {
        const { created } = await this.reservations.createForCatalog({
          submissionId: sub.id,
          number,
          lines: split.stock,
          projectId,
          projectName,
          entityId,
          purpose,
          neededBy,
          performedBy: userId,
          actor,
          object,
          task,
          taskProjectName,
        });
        made.push(...created.map((c: any) => c.id));
        madeStock.push(...created.map((c: any) => ({ itemName: c.itemName, quantity: c.quantity, status: c.status })));
      }
      if (purchaseLines.length) {
        // PurchaseRequisition has no object column: the object rides in the
        // title and the comment; the submission keeps the id (decided 2026-10-08).
        // Owner 2026-10-08: the object's NAME only, never its code.
        // A task's requisition is bound to the task (#1894's taskId), so the
        // task modal's purchase list shows it too; the task also rides in the
        // title and the comment.
        const objectNote = object ? `Օբյեկտ՝ ${object.name}` : null;
        const taskNote = task ? `Առաջադրանք՝ #${task.id} ${task.title}`.trim() : null;
        requisition = await this.requisitions.create(
          {
            title: task
              ? `Կատալոգ · ${number} · Առաջադրանք #${task.id}`
              : object ? `Կատալոգ · ${number} · ${object.name}` : `Կատալոգ · ${number}`,
            comment: [purpose, taskNote, objectNote, dto.comment?.trim() || null].filter(Boolean).join('\n'),
            periodEnd: neededBy.toISOString().slice(0, 10),
            lines: purchaseLines,
            ...(task ? { taskId: task.id } : {}),
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
    this.announceCheckout(sub, madeStock, purchaseLines.map((l) => ({ itemName: l.itemName ?? '', quantity: l.quantity })), requisition, object, task);
    return this.getOne(sub.id, actor);
  }

  // ── Construction objects (2026-10-08) ─────────────────────────────────────
  //
  // An object's responsible person orders for the object through the catalog
  // (the CRM object page's «Հայտ կատալոգից» opens /catalog?objectId=). Who may
  // ask is what createForObject asked: the responsible person as CRM's card
  // names them — or manage_reservations / a super admin, who may also supply
  // the object directly. The rows then follow the object rules.

  /** May this actor order for any object they like (the desk), rather than only their own? */
  private ordersForAnyObject(actor: WarehouseActor): boolean {
    return actor.isSuperAdmin || (actor.permissionNames ?? []).includes('manage_reservations');
  }

  /** The object's fresh card, once the caller is allowed to order for it. */
  private async objectForCheckout(objectId: number, actor: WarehouseActor): Promise<CrmObjectCard> {
    if (!Number.isInteger(objectId) || objectId <= 0) throw new BadRequestException('Օբյեկտը սխալ է նշված');
    const card = await fetchCrmObjectCard(objectId);
    if (!card.responsibleId) {
      throw new BadRequestException('Օբյեկտը պատասխանատու չունի — նախ նշանակեք պատասխանատու, որը կհաստատի ստացումը');
    }
    if (!this.ordersForAnyObject(actor) && !isResponsibleOf(card, actor.userId)) {
      throw new ForbiddenException('Օբյեկտի համար պահեստային հայտ ներկայացնում է միայն օբյեկտի պատասխանատուն');
    }
    return card;
  }

  /**
   * The objects this person may order for — the cart's «Օբյեկտ» picker: their
   * own (responsible person), every object for the desk. CRM's cached
   * catalogue; the checkout itself asks the fresh card.
   */
  async objectsForRequester(actor: WarehouseActor) {
    if (!this.objects) return [];
    // Past the 60 s cache: the CRM object page sends people here right after an object (or its responsible person) was set.
    const all = await this.objects.crmObjectsFresh();
    const mine = this.ordersForAnyObject(actor) ? all : all.filter((o) => o.responsibleId != null && o.responsibleId === actor.userId);
    const projectName = mine.some((o) => o.projectId) ? await this.crmProjectNames() : new Map<number, string>();
    return mine.map((o) => ({
      id: o.id,
      code: o.code,
      name: o.name,
      projectId: o.projectId ?? null,
      projectName: o.projectId ? (projectName.get(o.projectId) ?? null) : null,
      entityId: o.entityId ?? null,
      status: o.status,
    }));
  }

  /**
   * The cart's project picker (GET /catalog/projects, 2026-10-09): id and name
   * only, by name. CRM unreachable → an empty list, never an error, so the
   * cart still files without a project.
   */
  async projectsForRequester(): Promise<{ id: number; name: string }[]> {
    const names = await this.crmProjectNames();
    return [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'hy'));
  }

  /** CRM's project names (the list warehouses.service reads for its picker); unreachable → no names, the picker still works. */
  private async crmProjectNames(wanted?: number): Promise<Map<number, string>> {
    const names = await this.fetchCrmProjectNames();
    // One retry when the project asked for is missing: a transient CRM miss must not leave a card without its project (2026-10-08).
    if (wanted != null && !names.has(wanted)) return this.fetchCrmProjectNames();
    return names;
  }

  private async fetchCrmProjectNames(): Promise<Map<number, string>> {
    try {
      const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
      const res = await fetch(`${crmUrl}/api/projects/internal`, { headers: { 'x-internal-secret': requireInternalSecret() } });
      if (!res.ok) return new Map();
      return new Map(((await res.json()) as { id: number; name: string }[]).map((p) => [p.id, p.name]));
    } catch {
      return new Map();
    }
  }

  /**
   * An object's catalog submissions — the CRM object page's «Պահեստային
   * հայտեր» tab. Read as GET /reservations/object/:id is read (owner
   * 2026-10-05): view_object_requests or a super admin, else the object's
   * responsible person as CRM's card names them. No card, no object: 403.
   */
  async forObject(objectId: number, actor: WarehouseActor): Promise<SubmissionView[]> {
    if (!holdsObjectRight(actor.permissionNames ?? [], actor.isSuperAdmin, OBJECT_PAGE_RIGHT.requests)) {
      const card = await fetchCrmObjectCard(objectId).catch(() => null);
      if (!isResponsibleOf(card, actor.userId)) throw new ForbiddenException('Օբյեկտի հայտերը դիտելու իրավունք չկա');
    }
    return this.views({ objectId }, actor.userId);
  }

  // ── Tasks (2026-10-08) ────────────────────────────────────────────────────
  //
  // A task's people order for the task through the catalog: the CRM task
  // modal's «Հայտ կատալոգից» opens /catalog?taskId=, its «Ընտրել կատալոգից»
  // drawer checks out from inside CRM. Who may ask is isOnTask's rule (owner
  // 2026-10-08, kept): the task's creator or one of its role slots — or the
  // desk (manage_reservations / a super admin). The task decides the project
  // and the object; the rows are task rows (ReservationsService.createForCatalog).

  /** The task's card, once the caller is allowed to order for it. */
  private async taskForCheckout(taskId: number, actor: WarehouseActor): Promise<CrmTaskCard> {
    if (!Number.isInteger(taskId) || taskId <= 0) throw new BadRequestException('Առաջադրանքը սխալ է նշված');
    const card = await this.reservations.taskCard(taskId);
    if (!this.ordersForAnyObject(actor) && !this.onTask(card, actor.userId)) {
      throw new ForbiddenException('Առաջադրանքի համար պահեստային հայտ ներկայացնում են միայն առաջադրանքի մասնակիցները');
    }
    if (!card.projectId) throw new BadRequestException('Առաջադրանքի նախագիծը որոշված չէ — պահեստային հայտն արգելափակված է');
    return card;
  }

  /** isOnTask's rule on a card already fetched: the creator or a role slot. */
  private onTask(card: CrmTaskCard, userId: number): boolean {
    return card.createdById === userId || card.people.includes(userId);
  }

  /**
   * The task as the catalog chip shows it (/catalog?taskId=): title, project,
   * object — answered only to someone who may order for it, so the chip never
   * pins a task the checkout would refuse. Object label from CRM's catalogue.
   */
  async taskForRequester(taskId: number, actor: WarehouseActor) {
    const card = await this.taskForCheckout(taskId, actor);
    const [projectNames, objectOf] = await Promise.all([
      card.projectId ? this.crmProjectNames(card.projectId) : Promise.resolve(new Map<number, string>()),
      card.objectId ? this.objectLabels([card.objectId]) : Promise.resolve(new Map()),
    ]);
    const object = card.objectId ? (objectOf.get(card.objectId) ?? { id: card.objectId, code: null, name: null }) : null;
    return {
      id: card.id,
      title: card.title,
      projectId: card.projectId,
      projectName: card.projectId ? (projectNames.get(card.projectId) ?? null) : null,
      objectId: card.objectId,
      objectName: object?.name ?? null,
    };
  }

  /**
   * A task's catalog submissions — the CRM task modal's warehouse block. Read
   * as GET /reservations/task/:id is read: being on the task opens all of
   * them; so does being warehouse staff (the reservation readers) or the queue;
   * otherwise the task's own company may follow its orders. CRM unreachable
   * is "not on it": nothing is guessed. Nobody with standing: 403.
   */
  async forTask(taskId: number, actor: WarehouseActor): Promise<SubmissionView[]> {
    if (!(await this.mayReadTask(taskId, actor))) throw new ForbiddenException('Առաջադրանքի հայտերը դիտելու իրավունք չկա');
    return this.views({ taskId }, actor.userId);
  }

  private async mayReadTask(taskId: number, actor: WarehouseActor): Promise<boolean> {
    if (actor.isSuperAdmin || isReservationReader(actor) || this.isQueueViewer(actor)) return true;
    if (await this.reservations.isOnTask(taskId, actor.userId)) return true;
    try {
      const card = await this.reservations.taskCard(taskId);
      const requester = card.projectId ? await this.reservations.requesterOfProject(card.projectId) : null;
      return requester != null && decideWorkspace(actor, requester).allowed;
    } catch {
      return false;
    }
  }

  /** Title + project of the tasks some submissions name — CRM's card, kept briefly; CRM down → ids only. */
  private taskLabelCache = new Map<number, { at: number; value: { id: number; title: string | null; projectId: number | null } }>();
  private static readonly TASK_LABEL_FRESH_MS = 120_000;
  private async taskLabels(ids: number[]): Promise<Map<number, { id: number; title: string | null; projectId: number | null }>> {
    const map = new Map<number, { id: number; title: string | null; projectId: number | null }>();
    const now = Date.now();
    const missing: number[] = [];
    for (const id of ids) {
      const hit = this.taskLabelCache.get(id);
      if (hit && now - hit.at < CatalogService.TASK_LABEL_FRESH_MS) map.set(id, hit.value);
      else missing.push(id);
    }
    // A few at a time: the queue may list hundreds of task submissions on one page.
    for (let i = 0; i < missing.length; i += 8) {
      await Promise.all(
        missing.slice(i, i + 8).map(async (id) => {
          const value = await this.reservations
            .taskCard(id)
            .then((c) => ({ id: c.id, title: c.title || null, projectId: c.projectId }))
            .catch(() => ({ id, title: null, projectId: null }));
          this.taskLabelCache.set(id, { at: Date.now(), value });
          map.set(id, value);
        }),
      );
    }
    return map;
  }

  /** Code + name of the objects some submissions name; CRM down → ids only, the list still works. */
  private async objectLabels(ids: number[]): Promise<Map<number, { id: number; code: string | null; name: string | null }>> {
    const map = new Map<number, { id: number; code: string | null; name: string | null }>();
    if (!ids.length || !this.objects) return map;
    try {
      const want = new Set(ids);
      for (const o of await this.objects.crmObjects()) if (want.has(o.id)) map.set(o.id, { id: o.id, code: o.code, name: o.name });
      // An object made a moment ago postdates the 60 s catalogue — read past the cache once (2026-10-08).
      if (map.size < want.size) {
        for (const o of await this.objects.crmObjectsFresh()) if (want.has(o.id)) map.set(o.id, { id: o.id, code: o.code, name: o.name });
      }
    } catch { /* labels are cosmetic */ }
    return map;
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
    // Phase 3 (2026-10-07): a file added after filing reaches the desk.
    this.notify({
      type: WAREHOUSE_TYPES.requestAttachment,
      permissions: [QUEUE_PERMISSION],
      entityIds: [loaded.sub.entityId],
      actorId: userId,
      title: 'Հարցմանը ֆայլ է կցվել',
      body: `Հարցում ${loaded.sub.number}՝ ներկայացնողը կցել է «${Buffer.from(file.originalname, 'latin1').toString('utf8')}» ֆայլը։`,
      path: `/goods-requests?tab=approve&id=${id}`,
      details: [{ label: 'Հարցում', value: loaded.sub.number }],
    });
    return this.getOne(id, actor);
  }

  // ── Reading ───────────────────────────────────────────────────────────────

  /** May open the queue and read any submission: the desk, the keepers (QUEUE_VIEWER_PERMISSIONS), the warehouse super-permission. */
  isQueueViewer(actor: WarehouseActor): boolean {
    const names = actor.permissionNames ?? [];
    return actor.isSuperAdmin || names.includes('manage_warehouse') || QUEUE_VIEWER_PERMISSIONS.some((p) => names.includes(p));
  }

  /** The catalog desk proper (view_catalog_requests): the only ones who remind a submitter. */
  private isDesk(actor: WarehouseActor): boolean {
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

  /**
   * The queue («Ապրանքների հարցումներ» → «Հաստատում»): every submission —
   * catalog, object, task, direct supply — filtered as the design filters,
   * plus the keeper's two (2026-10-08): `warehouseId` ('main' or a sub's id:
   * requests with a stock line drawn from that pool) and `source`.
   */
  async queue(query: Record<string, string | undefined>, actor: WarehouseActor) {
    const where: any = {};
    if (Number(query.entityId) > 0) where.entityId = Number(query.entityId);
    if (Number(query.requesterId) > 0) where.createdBy = Number(query.requesterId);
    if (query.warehouseId === 'main') where.reservations = { some: { warehouseId: null } };
    else if (Number(query.warehouseId) > 0) where.reservations = { some: { warehouseId: Number(query.warehouseId) } };
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
    // «Տրված» (2026-10-08): the former «Հատկացումներ» page / «Տրամադրում» filter —
    // requests with goods handed out and not yet confirmed received.
    if (status === 'ISSUED') out = out.filter((v) => v.lines.some((l) => l.kind === 'STOCK' && l.reclaimableQuantity > 0));
    const source = query.source?.trim().toUpperCase();
    if (source && (SUBMISSION_SOURCES as string[]).includes(source)) out = out.filter((v) => v.source === source);
    const kind = query.kind?.trim().toUpperCase();
    if (kind && ['STOCK', 'PURCHASE', 'NEW'].includes(kind)) out = out.filter((v) => v.lines.some((l) => l.kind === kind));
    const q = query.q?.trim().toLowerCase();
    if (q) {
      out = out.filter((v) =>
        [v.number, v.purpose, v.projectName, v.costCenter, v.object?.code, v.object?.name, `${v.requester.firstName} ${v.requester.lastName}`, ...v.lines.map((l) => l.itemName)]
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
          // The keeper's view (2026-10-08): the live allocations by id and serial, both histories, the pool.
          allocations: { where: { releasedAt: null }, select: { id: true, quantity: true, assetId: true, asset: { select: { serialNumber: true, name: true } } }, orderBy: { id: 'asc' } },
          allocationHistory: { include: { asset: { select: { serialNumber: true, name: true } } }, orderBy: { performedAt: 'asc' } },
          statusHistory: { orderBy: { performedAt: 'asc' } },
          warehouse: { select: { id: true, name: true } },
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
      ...l.reservations.flatMap((r) => ((r.allocationHistory ?? []) as any[]).map((h) => h.performedBy)),
      l.sub.lastReminderBy,
      ...this.remindersOf(l.sub).map((x) => x.by),
    ]);
    const reservationIds = loaded.flatMap((l) => l.reservations.map((r) => r.id));
    const [free, users, dir, objectOf, taskOf, pool, requisitionOf] = await Promise.all([
      this.freeStock(itemIds, { raw: true }),
      this.usersPrisma.getUsersByIds([...new Set(userIds.filter((x): x is number => typeof x === 'number'))]),
      this.directory(),
      this.objectLabels([...new Set(loaded.map((l) => l.sub.objectId).filter((x): x is number => typeof x === 'number'))]),
      this.taskLabels([...new Set(loaded.map((l) => l.sub.taskId).filter((x): x is number => typeof x === 'number'))]),
      this.poolFree(loaded.flatMap((l) => l.reservations)),
      this.lineRequisitions(reservationIds),
    ]);
    const userOf = new Map(users.map((u) => [u.id, u]));
    const person = (id: number | null | undefined): Person => {
      if (id == null) return null;
      const u = userOf.get(id);
      return { id, name: u ? `${u.firstName} ${u.lastName}`.trim() : `#${id}` };
    };
    return loaded.map((l) => this.toView(l, { free, userOf, person, dir, viewerId, objectOf, taskOf, pool, requisitionOf }));
  }

  /**
   * The purchase requisition raised for each short line, if any — the
   * reservation service's own lookup (the old Reservations page's «Հայտ #N»
   * chip). Specs that mock the service without it get none.
   */
  private async lineRequisitions(reservationIds: number[]): Promise<Map<number, { id: number; status: string }>> {
    try {
      const found = await (this.reservations as any).requisitionsFor?.(reservationIds);
      return found instanceof Map ? found : new Map();
    } catch {
      return new Map();
    }
  }

  /**
   * What is free in a SUB-warehouse pool for the lines drawn from it (2026-10-08):
   * the sub's shelf (or its AVAILABLE units with a responsible person) less the
   * other live claims on that pool, raw — the line adds its own claim back, as
   * the main-pool figure does. Main-pool rows keep freeStock's answer. The
   * figure is for the keeper's eye; the hand-out itself re-measures under lock.
   */
  private async poolFree(rows: any[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    const pairs = new Map<string, { warehouseId: number; itemId: number; type: string | null }>();
    for (const r of rows) if (r.warehouseId) pairs.set(`${r.warehouseId}:${r.itemId}`, { warehouseId: r.warehouseId, itemId: r.itemId, type: r.item?.type ?? null });
    if (!pairs.size) return out;
    try {
      const list = [...pairs.values()];
      const now = new Date();
      const consumables = list.filter((p) => p.type !== ItemType.ASSET);
      const assets = list.filter((p) => p.type === ItemType.ASSET);
      const [stocks, units, claims] = await Promise.all([
        consumables.length
          ? this.prisma.warehouseStock.findMany({
              where: { OR: consumables.map((p) => ({ warehouseId: p.warehouseId, itemId: p.itemId })) },
              select: { warehouseId: true, itemId: true, quantity: true },
            })
          : [],
        assets.length
          ? this.prisma.asset.groupBy({
              by: ['itemId', 'warehouseId'],
              where: {
                OR: assets.map((p) => ({ warehouseId: p.warehouseId, itemId: p.itemId })),
                status: 'AVAILABLE',
                custodies: { some: { releasedAt: null, holderType: 'USER' } },
              },
              _count: { id: true },
            })
          : [],
        this.prisma.resourceReservation.findMany({
          where: {
            OR: list.map((p) => ({ warehouseId: p.warehouseId, itemId: p.itemId })),
            status: { in: ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'] },
            AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }],
          },
          select: { itemId: true, warehouseId: true, quantity: true, status: true },
        }),
      ]);
      const shelf = new Map<string, number>();
      for (const s of stocks as any[]) shelf.set(`${s.warehouseId}:${s.itemId}`, Number(s.quantity ?? 0));
      for (const u of units as any[]) shelf.set(`${u.warehouseId}:${u.itemId}`, Number(u._count?.id ?? 0));
      const claimed = new Map<string, number>();
      for (const c of claims as any[]) {
        const key = `${c.warehouseId}:${c.itemId}`;
        const type = pairs.get(key)?.type;
        const live = type === ItemType.ASSET ? ['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'] : ['PENDING', 'APPROVED'];
        if (live.includes(c.status)) claimed.set(key, (claimed.get(key) ?? 0) + Number(c.quantity ?? 0));
      }
      for (const key of pairs.keys()) out.set(key, roundQty((shelf.get(key) ?? 0) - (claimed.get(key) ?? 0)));
    } catch (e: any) {
      this.logger.warn(`pool free-stock lookup failed: ${e?.message ?? e}`);
    }
    return out;
  }

  private lineOfReservation(
    r: any,
    free: Map<number, number>,
    extra: { pool?: Map<string, number>; person?: (id: number | null | undefined) => Person; requisition?: { id: number; status: string } | null } = {},
  ): SubmissionLine {
    const issued = roundQty((r.allocations ?? []).reduce((s: number, a: any) => s + (a.quantity ?? 0), 0));
    const stage = stageOf('STOCK', r.status, { issued });
    const isAsset = r.item?.type === ItemType.ASSET;
    const type = r.item?.type;
    // Main pool: freeStock's figure plus the line's own claim. A sub-warehouse
    // row: that pool's figure (poolFree), its own claim added back the same way.
    const inStock = r.warehouseId
      ? availableForLine(extra.pool?.get(`${r.warehouseId}:${r.itemId}`) ?? 0, ownClaim({ ...r, warehouseId: null, type }))
      : availableForLine(free.get(r.itemId) ?? 0, ownClaim({ ...r, type }));
    const accepted = roundQty(Number(r.acceptedQuantity ?? 0));
    const person = extra.person ?? (() => null);
    const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : '');
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
      inStock,
      isAsset,
      issuedQuantity: issued,
      acceptedQuantity: accepted,
      status: r.status,
      statusLabel: stockLineLabel(stage, inStock, r.quantity, reservationStatusLabel(r.status)),
      reservationId: r.id,
      requisitionId: null,
      requisitionLineId: null,
      warehouse: r.warehouse ? { id: r.warehouse.id, name: r.warehouse.name } : null,
      freeQuantity: inStock,
      outstandingQuantity: roundQty(Math.max(0, Number(r.quantity) - issued)),
      reclaimableQuantity: roundQty(Math.max(0, issued - accepted)),
      allocations: ((r.allocations ?? []) as any[]).map((a) => ({
        id: a.id,
        assetId: a.assetId ?? null,
        serialNumber: a.asset?.serialNumber ?? a.asset?.name ?? null,
        quantity: Number(a.quantity ?? 1),
      })),
      allocationHistory: ((r.allocationHistory ?? []) as any[]).map((h) => ({
        at: iso(h.performedAt),
        action: h.action,
        by: person(h.performedBy),
        serialNumber: h.asset?.serialNumber ?? h.asset?.name ?? null,
        notes: h.notes ?? null,
      })),
      statusHistory: ((r.statusHistory ?? []) as any[]).map((h) => ({
        at: iso(h.performedAt),
        from: h.fromStatus ?? null,
        to: h.toStatus,
        by: person(h.performedBy),
        reason: h.reason ?? null,
        previousQuantity: h.previousQuantity ?? null,
        newQuantity: h.newQuantity ?? null,
      })),
      requisition: extra.requisition ?? null,
      stage,
    };
  }

  /** The empty keeper's shape of a purchase/new line. */
  private static readonly NO_STOCK_VIEW = {
    warehouse: null,
    freeQuantity: 0,
    outstandingQuantity: 0,
    reclaimableQuantity: 0,
    allocations: [] as SubmissionLine['allocations'],
    allocationHistory: [] as SubmissionLine['allocationHistory'],
    statusHistory: [] as SubmissionLine['statusHistory'],
    requisition: null,
  };

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
      inStock: line.itemId ? Math.max(0, free.get(line.itemId) ?? 0) : null,
      isAsset: false,
      issuedQuantity: 0,
      acceptedQuantity: 0,
      status: req.status,
      statusLabel: REQUISITION_LABELS[req.status] ?? req.status,
      reservationId: null,
      requisitionId: req.id,
      requisitionLineId: line.id,
      ...CatalogService.NO_STOCK_VIEW,
      stage,
    };
  }

  private linesOf(
    l: Loaded,
    free: Map<number, number>,
    extra: { pool?: Map<string, number>; person?: (id: number | null | undefined) => Person; requisitionOf?: Map<number, { id: number; status: string }> } = {},
  ): SubmissionLine[] {
    return [
      ...l.reservations.map((r) => this.lineOfReservation(r, free, { pool: extra.pool, person: extra.person, requisition: extra.requisitionOf?.get(r.id) ?? null })),
      ...((l.requisition?.lines ?? []) as any[]).map((line) => this.lineOfRequisition(l.requisition, line, free)),
    ];
  }

  private toView(
    l: Loaded,
    ctx: {
      free: Map<number, number>;
      userOf: Map<number, any>;
      person: (id: number | null | undefined) => Person;
      dir: Directory;
      viewerId: number;
      objectOf?: Map<number, { id: number; code: string | null; name: string | null }>;
      taskOf?: Map<number, { id: number; title: string | null; projectId: number | null }>;
      pool?: Map<string, number>;
      requisitionOf?: Map<number, { id: number; status: string }>;
    },
  ): SubmissionView {
    const { sub, requisition } = l;
    const lines = this.linesOf(l, ctx.free, { pool: ctx.pool, person: ctx.person, requisitionOf: ctx.requisitionOf });
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
    for (const r of this.remindersOf(sub)) {
      timeline.push({ at: r.at, kind: 'info_reminder', by: ctx.person(r.by), text: 'Հիշեցում ուղարկվեց' });
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
    const direct =
      !!sub.objectId &&
      (sub.purpose === DIRECT_SUPPLY_PURPOSE ||
        (l.reservations.length > 0 && l.reservations.every((r) => (r.statusHistory as any[])?.[0]?.reason === 'Պահեստը տրամադրում է օբյեկտին')));

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
      objectId: sub.objectId ?? null,
      object: sub.objectId ? (ctx.objectOf?.get(sub.objectId) ?? { id: sub.objectId, code: null, name: null }) : null,
      taskId: sub.taskId ?? null,
      task: sub.taskId ? (ctx.taskOf?.get(sub.taskId) ?? { id: sub.taskId, title: null, projectId: sub.projectId ?? null }) : null,
      direct,
      source: sourceOf({ taskId: sub.taskId, objectId: sub.objectId, direct }),
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
      reminder: sub.lastReminderAt
        ? {
            lastAt: iso(sub.lastReminderAt)!,
            by: ctx.person(sub.lastReminderBy),
            nextAt: new Date(new Date(sub.lastReminderAt).getTime() + REMINDER_INTERVAL_MS).toISOString(),
          }
        : null,
      approver,
    };
  }

  /** The reminders kept on a submission, [{ at, by }], whatever shape the column holds. */
  private remindersOf(sub: any): { at: string; by: number | null }[] {
    const raw = Array.isArray(sub?.reminders) ? sub.reminders : [];
    return raw
      .filter((x: any) => x && typeof x.at === 'string')
      .map((x: any) => ({ at: x.at, by: typeof x.by === 'number' ? x.by : null }));
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
    const changed: string[] = [];
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
        changed.push(`${r.item?.name ?? `#${r.itemId}`}: ${r.quantity} → ${quantity}`);
        await this.prisma.resourceReservation.update({ where: { id: r.id }, data: { quantity } });
        await this.noteOnReservation(r, userId, 'Քանակը փոխվել է ներկայացնողի կողմից', { previousQuantity: r.quantity, newQuantity: quantity });
      } else {
        const before = (loaded.requisition?.lines ?? []).find((x: any) => x.id === ref.rowId);
        if (before && Math.abs((before.quantity ?? 0) - quantity) < 1e-9) continue;
        changed.push(`${before?.itemName ?? line.itemName ?? 'Տող'}: ${before?.quantity ?? '—'} → ${quantity}`);
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
    if (data.purpose !== undefined && data.purpose !== loaded.sub.purpose) changed.push('նպատակ');
    if (data.comment !== undefined && data.comment !== (loaded.sub.comment ?? null)) changed.push('մեկնաբանություն');
    if (data.neededBy && +data.neededBy !== +new Date(loaded.sub.neededBy)) changed.push(`անհրաժեշտ է մինչև ${data.neededBy.toISOString().slice(0, 10)}`);
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
    // Phase 3 (2026-10-07): the desk hears the requester changed a request it may be weighing.
    if (changed.length) {
      this.notify({
        type: WAREHOUSE_TYPES.catalogRequestEdited,
        permissions: [QUEUE_PERMISSION],
        entityIds: [loaded.sub.entityId],
        actorId: userId,
        title: 'Կատալոգի հարցումը խմբագրվել է',
        body: `Հարցում ${loaded.sub.number}՝ ներկայացնողը փոխել է՝ ${changed.join(', ')}։`,
        path: `/goods-requests?tab=approve&id=${id}`,
        details: [{ label: 'Հարցում', value: loaded.sub.number }, { label: 'Փոփոխություններ', value: changed.join(', ') }],
      });
    }
    return this.getOne(id, actor);
  }

  async cancel(id: number, userId: number, actor: WarehouseActor): Promise<SubmissionView> {
    const { loaded } = await this.ownEditable(id, userId, 'Հարցումը կարող է չեղարկել միայն ներկայացնողը');
    const withdrawn: string[] = [];
    for (const r of loaded.reservations) {
      if (RESERVATION_LIVE.includes(r.status)) {
        // Quiet: the desk hears of the whole withdrawal once, below.
        await this.reservations.cancel(r.id, userId, 'Հարցումը չեղարկվել է ներկայացնողի կողմից', actor, { quiet: true });
        withdrawn.push(`${r.item?.name ?? `#${r.itemId}`} × ${r.quantity}`);
      }
    }
    if (loaded.requisition && REQUISITION_CANCELLABLE.includes(loaded.requisition.status)) {
      // Quiet: the cancelled submission below is the one notice.
      await this.requisitions.cancel(loaded.requisition.id, userId, actor.isSuperAdmin, { quiet: true });
    }
    await this.prisma.catalogSubmission.update({
      where: { id },
      data: { cancelledAt: new Date(), infoRequestText: null, infoRequestBy: null, infoRequestAt: null },
    });
    // Phase 2: the desk learns the submitter walked away (reservation_cancelled, the other side).
    this.notify({
      type: WAREHOUSE_TYPES.reservationCancelled,
      permissions: [QUEUE_PERMISSION],
      entityIds: [loaded.sub.entityId],
      actorId: userId,
      title: 'Կատալոգի հարցումը չեղարկվել է',
      body: `Հարցում ${loaded.sub.number}՝ չեղարկվել է ներկայացնողի կողմից${withdrawn.length ? ` (${withdrawn.join(', ')})` : ''}։`,
      path: `/goods-requests?tab=approve&id=${id}`,
      details: [{ label: 'Հարցում', value: loaded.sub.number }],
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
      await this.requisitions.addComment(req.id, userId, `Պատասխան՝ ${answer}`, undefined, { quiet: true });
      if (file) await this.requisitions.addAttachment(req.id, userId, file, undefined, { quiet: true });
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
    // Phase 2: the reply reaches the desk — whoever asked first among them.
    this.notify({
      type: WAREHOUSE_TYPES.catalogRequestReceived,
      permissions: [QUEUE_PERMISSION],
      entityIds: [loaded.sub.entityId],
      userIds: [loaded.sub.infoRequestBy],
      actorId: userId,
      title: 'Պատասխան կատալոգի հարցմանը',
      body: `Հարցում ${loaded.sub.number}՝ ներկայացնողը պատասխանել է՝ ${answer}`,
      path: `/goods-requests?tab=approve&id=${id}`,
      details: [
        { label: 'Հարցում', value: loaded.sub.number },
        ...(loaded.sub.infoRequestText ? [{ label: 'Հարց', value: loaded.sub.infoRequestText }] : []),
        { label: 'Պատասխան', value: answer },
      ],
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
      return { ...line, approvedQuantity: roundQty(Number(d.approvedQuantity)), assetIds: d.assetIds };
    });
    const { allowed, skipped } = partitionByRights(asked, rights);
    if (!allowed.length) throw new ForbiddenException('Դուք այս հարցման տողերը հաստատելու թույլտվություն չունեք');
    const comment = dto.comment?.trim() || undefined;

    // Stock lines first: they can fail on the shelf, and a refused issuance
    // should not leave purchase lines approved behind it. Every stock line is
    // checked before anything moves — an asset line's picked units included
    // (REQ-1015), so a wrong pick refuses the whole decision untouched.
    const stock = allowed.filter((x) => x.kind === 'STOCK');
    const picks = new Map<number, number[]>();
    const pickedAnywhere = new Set<number>();
    for (const line of stock) {
      const r = loaded.reservations.find((x) => x.id === line.reservationId)!;
      if (!RESERVATION_LIVE.includes(r.status) || line.stage === 'READY') {
        throw new BadRequestException(`«${line.itemName}» — տողն արդեն «${reservationStatusLabel(r.status)}» կարգավիճակում է`);
      }
      if (line.approvedQuantity === 0) continue;
      if (line.approvedQuantity > r.quantity) {
        throw new BadRequestException(`«${line.itemName}» — հաստատվող քանակը (${line.approvedQuantity}) գերազանցում է պահանջվածը (${r.quantity})`);
      }
      if (r.item?.type === ItemType.ASSET && !Number.isInteger(line.approvedQuantity)) {
        throw new BadRequestException('Ակտիվների քանակը պետք է լինի ամբողջ թիվ');
      }
      if (r.item?.type !== ItemType.ASSET) continue;
      const ids = await this.checkPicks(r, line, line.assetIds);
      for (const assetId of ids) {
        if (pickedAnywhere.has(assetId)) throw new BadRequestException(`Միավոր #${assetId}-ը ընտրված է երկու տողի համար`);
        pickedAnywhere.add(assetId);
      }
      picks.set(r.id, ids);
    }

    let changed = 0;
    for (const line of stock) {
      const r = loaded.reservations.find((x) => x.id === line.reservationId)!;
      if (line.approvedQuantity === 0) {
        await this.reservations.reject(r.id, userId, comment ?? 'Մերժված է հաստատողի կողմից', actor, { quiet: true });
        changed++;
        continue;
      }
      if (line.approvedQuantity !== r.quantity) {
        changed++;
        await this.prisma.resourceReservation.update({ where: { id: r.id }, data: { quantity: line.approvedQuantity } });
        await this.noteOnReservation(r, userId, comment ?? 'Քանակը ճշգրտվել է հաստատման ժամանակ', {
          previousQuantity: r.quantity,
          newQuantity: line.approvedQuantity,
        });
      }
      if (r.item?.type === ItemType.ASSET) {
        // REQ-1015: approving an asset line hands out the picked units through
        // the Reservations page's own allocation — custody check, history and
        // the line's status follow the normal path.
        const ids = picks.get(r.id) ?? [];
        if (ids.length) {
          await this.reservations.allocate({ allocations: ids.map((assetId) => ({ reservationId: r.id, assetId })) }, userId, { quiet: true });
          changed++;
        } else if (r.status === 'PARTIALLY_ALLOCATED' && line.issuedQuantity >= line.approvedQuantity) {
          // Cut down to what is already out: the line is complete as it stands.
          await this.prisma.$transaction([
            this.prisma.resourceReservation.update({ where: { id: r.id }, data: { status: 'ALLOCATED' } }),
            this.prisma.reservationStatusHistory.create({
              data: { reservationId: r.id, fromStatus: 'PARTIALLY_ALLOCATED', toStatus: 'ALLOCATED', performedBy: userId, reason: comment ?? 'Հաստատված է կատալոգի հարցումների էջից' },
            }),
          ]);
          changed++;
        }
      } else {
        // The existing approval: everything still outstanding is issued.
        await this.reservations.approveConsumable(r.id, userId, undefined, actor, { quiet: true });
        changed++;
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
      if (comment) await this.requisitions.addComment(req.id, userId, comment, undefined, { quiet: true });
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
            undefined,
            { quiet: true },
          );
        }
        await this.requisitions.orgApprove(req.id, userId);
      }
      changed++;
      // The approver has taken the open question over.
      if (loaded.sub.infoRequestAt) {
        await this.prisma.catalogSubmission.update({ where: { id }, data: { infoRequestText: null, infoRequestBy: null, infoRequestAt: null } });
      }
    }
    // Nothing moved: no success, and nobody is told anything was approved.
    if (!changed) throw new BadRequestException('Ոչինչ չի փոխվել — ընտրեք տրվող միավորները կամ մերժեք տողը');
    const allRejected = allowed.every((x) => x.approvedQuantity === 0);
    void this.announceToSubmitter(id, actor, { kind: allRejected ? 'rejected' : 'approved', text: comment });
    return { ...(await this.getOne(id, actor)), skipped };
  }

  // ── Asset units (REQ-1015) ────────────────────────────────────────────────

  private assetReservationOf(loaded: Loaded, lineId: string) {
    const parsed = parseLineId(lineId);
    const r = parsed?.table === 'reservation' ? loaded.reservations.find((x) => x.id === parsed.rowId) : undefined;
    if (!r) throw new NotFoundException(`Տողը չի գտնվել (${lineId})`);
    if (r.item?.type !== ItemType.ASSET) throw new BadRequestException('Տողը ակտիվ չէ — միավորներ ընտրել պետք չէ');
    return r;
  }

  /**
   * The units this asset line may take: the Reservations page's own list
   * (GET /assets/available — the line's pool, no overlapping allocation or
   * maintenance, a responsible person on record), kept to units AVAILABLE
   * right now and not already on this very line.
   */
  private async freeUnitsOf(r: any): Promise<any[]> {
    if (!this.assets) throw new BadRequestException('Միավորների ցանկը հասանելի չէ');
    const rows = await this.assets.getAvailableAssets({
      itemId: r.itemId,
      startDate: new Date(r.startDate).toISOString(),
      endDate: r.endDate ? new Date(r.endDate).toISOString() : undefined,
      reservationId: r.id,
    });
    const mine = new Set(((r.allocations ?? []) as any[]).map((a) => a.assetId));
    return rows.filter((a: any) => a.status === 'AVAILABLE' && a.itemId === r.itemId && !mine.has(a.id));
  }

  /** The approver's pick for one asset line, refused unless every unit is free and of this item. */
  private async checkPicks(r: any, line: { itemName: string; approvedQuantity: number; issuedQuantity: number }, wanted?: number[]): Promise<number[]> {
    const ids = (wanted ?? []).map(Number);
    if (new Set(ids).size !== ids.length) throw new BadRequestException(`«${line.itemName}» — նույն միավորն ընտրված է երկու անգամ`);
    const need = line.approvedQuantity - line.issuedQuantity;
    if (need < 0) {
      throw new BadRequestException(`«${line.itemName}» — արդեն տրված է ${line.issuedQuantity} միավոր, հաստատվող քանակը չի կարող դրանից պակաս լինել`);
    }
    if (need === 0) {
      if (ids.length) throw new BadRequestException(`«${line.itemName}» — այլ միավոր տալ պետք չէ`);
      return [];
    }
    const free = await this.freeUnitsOf(r);
    if (!free.length) throw new BadRequestException(`«${line.itemName}» — Ազատ միավոր չկա․ մերժեք տողը կամ թողեք այն`);
    if (ids.length !== need) throw new BadRequestException(`«${line.itemName}» — ընտրեք ${need} միավոր (ընտրված է ${ids.length})`);
    const freeIds = new Set(free.map((a) => a.id));
    const bad = ids.filter((x) => !freeIds.has(x));
    if (bad.length) {
      throw new BadRequestException(`«${line.itemName}» — միավոր #${bad.join(', #')}-ը ազատ չէ կամ այս ապրանքից չէ`);
    }
    return ids;
  }

  /** GET …/lines/:lineId/units — what the approver picks from: serial, warehouse, condition, holder. */
  async unitsForLine(id: number, lineId: string, actor: WarehouseActor) {
    const loaded = await this.loadOne(id);
    const rights = await this.rightsOf(actor, loaded);
    if (!rights.stock) throw new ForbiddenException('Դուք պահեստային տողերը հաստատելու թույլտվություն չունեք');
    const r = this.assetReservationOf(loaded, lineId);
    const units = await this.freeUnitsOf(r);
    const whIds = [...new Set(units.map((u) => u.warehouseId).filter((x): x is number => typeof x === 'number'))];
    const whs = whIds.length ? await this.prisma.warehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, name: true } }) : [];
    const whName = new Map(whs.map((w) => [w.id, w.name]));
    const issued = ((r.allocations ?? []) as any[]).length;
    return {
      lineId,
      itemId: r.itemId,
      itemName: r.item?.name ?? `#${r.itemId}`,
      quantity: r.quantity,
      issued,
      units: units.map((u) => ({
        id: u.id,
        serialNumber: u.serialNumber ?? null,
        name: u.name ?? null,
        warehouseId: u.warehouseId ?? null,
        warehouseName: u.warehouseId ? whName.get(u.warehouseId) ?? `#${u.warehouseId}` : 'Գլխավոր պահեստ',
        status: u.status,
        notes: u.notes ?? null,
        responsibleName: u.responsibleName ?? null,
      })),
    };
  }

  /**
   * «Տրամադրել» from the queue (owner 2026-10-08): the keeper hands out part
   * or all of ONE stock line — the former Reservations page's «Տրամադրել»
   * (consumable quantity, #1880 partial issuance) and unit picker, now inside
   * the request. The reservation routes refuse catalog rows, so this is the
   * way: manage_reservations (rights.stock), a live line with something still
   * outstanding, the same service calls the catalog's approve makes —
   * approveConsumable with the quantity, allocate with the picked units —
   * quiet, and the submitter told once (ready to collect when it now is).
   */
  async issueLine(id: number, lineId: string, dto: IssueLineDto, userId: number, actor: WarehouseActor): Promise<SubmissionView> {
    const loaded = await this.loadOne(id);
    this.assertDecidable(loaded);
    const rights = await this.rightsOf(actor, loaded);
    if (!rights.stock) throw new ForbiddenException('Դուք պահեստից տրամադրելու թույլտվություն չունեք');
    const parsed = parseLineId(lineId);
    const r = parsed?.table === 'reservation' ? loaded.reservations.find((x) => x.id === parsed.rowId) : undefined;
    if (!r) throw new NotFoundException(`Տողը չի գտնվել (${lineId})`);
    const name = r.item?.name ?? `#${r.itemId}`;
    if (!['PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED'].includes(r.status)) {
      throw new BadRequestException(`«${name}» — տողն արդեն «${reservationStatusLabel(r.status)}» կարգավիճակում է`);
    }
    const issued = roundQty(((r.allocations ?? []) as any[]).reduce((s: number, a: any) => s + Number(a.quantity ?? 0), 0));
    const outstanding = roundQty(Number(r.quantity) - issued);
    if (outstanding <= 0) throw new BadRequestException(`«${name}» — տողն արդեն ամբողջությամբ տրամադրված է`);

    if (r.item?.type === ItemType.ASSET) {
      const ids = (dto.assetIds ?? []).map(Number);
      if (!ids.length) throw new BadRequestException(`«${name}» — ընտրեք տրվող միավորները`);
      if (new Set(ids).size !== ids.length) throw new BadRequestException(`«${name}» — նույն միավորն ընտրված է երկու անգամ`);
      if (ids.length > outstanding) throw new BadRequestException(`«${name}» — ընտրեք առավելագույնը ${outstanding} միավոր (ընտրված է ${ids.length})`);
      const free = await this.freeUnitsOf(r);
      const freeIds = new Set(free.map((a) => a.id));
      const bad = ids.filter((x) => !freeIds.has(x));
      if (bad.length) throw new BadRequestException(`«${name}» — միավոր #${bad.join(', #')}-ը ազատ չէ կամ այս ապրանքից չէ`);
      await this.reservations.allocate({ allocations: ids.map((assetId) => ({ reservationId: r.id, assetId })) }, userId, { quiet: true });
    } else {
      const quantity = roundQty(Number(dto.quantity ?? outstanding));
      if (!(quantity > 0)) throw new BadRequestException('Տրամադրվող քանակը պետք է լինի դրական թիվ');
      if (quantity > outstanding) {
        throw new BadRequestException(`Տրամադրվող քանակը (${quantity}) գերազանցում է չտրամադրված մնացորդը (${outstanding})`);
      }
      await this.reservations.approveConsumable(r.id, userId, quantity, actor, { quiet: true });
    }
    void this.announceToSubmitter(id, actor, { kind: 'approved' });
    return this.getOne(id, actor);
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
      if (RESERVATION_LIVE.includes(r.status)) await this.reservations.reject(r.id, userId, why, actor, { quiet: true });
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
    void this.announceToSubmitter(id, actor, { kind: 'rejected', text: why });
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
      await this.requisitions.addComment(req.id, userId, `Պահանջվում է տեղեկություն՝ ${question}`, undefined, { quiet: true });
      if (req.status === 'PENDING_APPROVAL') {
        await this.prisma.purchaseRequisition.update({ where: { id: req.id }, data: { status: 'DRAFT' } });
      }
    }
    await this.prisma.catalogSubmission.update({
      where: { id },
      data: { infoRequestText: question, infoRequestBy: userId, infoRequestAt: new Date() },
    });
    void this.announceToSubmitter(id, actor, { kind: 'info', text: question });
    return { ...(await this.getOne(id, actor)), skipped };
  }

  /**
   * «Հիշեցնել աշխատակցին» (2026-10-07): while the submitter has not answered
   * the desk's question, the catalog desk may remind them — once per request
   * per hour. The claim is one conditional update, so two presses at once send
   * one notice; the notice carries the original question, who reminds, and a
   * link to the submitter's own request page. Each reminder is kept for the
   * history («Հիշեցում ուղարկվեց»).
   */
  async remind(id: number, actor: WarehouseActor): Promise<SubmissionView> {
    if (!this.isDesk(actor)) throw new ForbiddenException('Հիշեցնել կարող է միայն կատալոգի հարցումների պատասխանատուն');
    const loaded = await this.loadOne(id);
    this.assertDecidable(loaded);
    const sub = loaded.sub;
    if (!sub.infoRequestAt) throw new BadRequestException('Հարցումը չի սպասում աշխատակցի պատասխանին');
    if (sub.createdBy === actor.userId) throw new BadRequestException('Դուք ինքներդ եք այս հարցման ներկայացնողը');

    const now = new Date();
    const cutoff = new Date(now.getTime() - REMINDER_INTERVAL_MS);
    const reminders = [...this.remindersOf(sub), { at: now.toISOString(), by: actor.userId }];
    const claimed = await this.prisma.catalogSubmission.updateMany({
      where: {
        id,
        infoRequestAt: { not: null },
        cancelledAt: null,
        OR: [{ lastReminderAt: null }, { lastReminderAt: { lte: cutoff } }],
      },
      data: { lastReminderAt: now, lastReminderBy: actor.userId, reminders },
    });
    if (!claimed.count) {
      const fresh = await this.prisma.catalogSubmission.findUnique({ where: { id }, select: { lastReminderAt: true, infoRequestAt: true } });
      if (!fresh?.infoRequestAt) throw new BadRequestException('Հարցումը չի սպասում աշխատակցի պատասխանին');
      const last = fresh.lastReminderAt ?? sub.lastReminderAt ?? now;
      throw new ConflictException(`Հիշեցումն արդեն ուղարկվել է ${yerevanClock(new Date(last))}-ին`);
    }

    const [me] = await this.usersPrisma.getUsersByIds([actor.userId]).catch(() => []);
    const who = me ? `${me.firstName} ${me.lastName}`.trim() : 'Կատալոգի պատասխանատուն';
    const asked = this.armenianStamp(new Date(sub.infoRequestAt));
    const question = sub.infoRequestText ?? '';
    this.notify({
      type: WAREHOUSE_TYPES.catalogInfoReminder,
      userIds: [sub.createdBy],
      actorId: actor.userId,
      title: 'Հիշեցում՝ պատասխանեք կատալոգային հարցմանը',
      body: `Հարցում ${sub.number}՝ ${who} հիշեցնում է, որ սպասում են Ձեր պատասխանին ${asked}-ի հարցին՝ «${question}»։`,
      path: `/goods-requests?tab=mine&id=${id}`,
      details: [
        { label: 'Հարցում', value: sub.number },
        { label: 'Հարց', value: question },
        { label: 'Հարցը տրվել է', value: asked },
        { label: 'Հիշեցնում է', value: who },
      ],
    });
    return this.getOne(id, actor);
  }

  /** DD.MM.YYYY, HH:mm in Yerevan. */
  private armenianStamp(d: Date): string {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Yerevan', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
      }).formatToParts(d).map((p) => [p.type, p.value]),
    );
    return `${parts.day}.${parts.month}.${parts.year}, ${parts.hour}:${parts.minute}`;
  }
}
