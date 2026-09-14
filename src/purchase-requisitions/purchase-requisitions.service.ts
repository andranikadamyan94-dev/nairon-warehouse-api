import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { UsersPrismaService } from '../common/users-prisma.service';
import { FileService } from '../common/file.service';

type Ctx = { isSuperAdmin?: boolean; permissionNames?: string[] };

export type LineInput = {
  itemId?: number | null;
  itemName?: string;
  code?: string | null;
  unit?: string | null;
  quantity: number;
  note?: string | null;
};

// A requester may still change the lines while the organization is deciding;
// once approved, what procurement receives is what was approved.
const EDITABLE = ['DRAFT', 'PENDING_APPROVAL'];
const REVIEWABLE = ['SUBMITTED', 'IN_REVIEW'];
const CANCELLABLE = ['DRAFT', 'PENDING_APPROVAL', 'SUBMITTED', 'IN_REVIEW'];
/** What procurement's queue lists: nothing the organization has not let through. */
const QUEUE_HIDDEN = ['DRAFT', 'PENDING_APPROVAL'];

export const CREATE_PERMISSION = 'create_purchase_requisition';
export const APPROVE_PERMISSION = 'approve_purchase_requisition';
/** Orders whose lines still count as "coming" for the expected-quantity snapshot. */
const OPEN_ORDER_STATUSES = ['PENDING_FINANCE_APPROVAL', 'FINANCE_APPROVED', 'ORDERED', 'PARTIALLY_RECEIVED'];

/**
 * #1885/#1888-#1894 purchase requisitions. Someone holding
 * create_purchase_requisition in their organization files one (their own are
 * theirs to see and edit) — it waits as PENDING_APPROVAL until someone holding
 * approve_purchase_requisition in THAT organization lets it through (→
 * SUBMITTED) or turns it down (→ REJECTED with a reason). Only then does
 * procurement (manage_procurement) see it: review, resolve catalog items for
 * free-text lines, approve — which raises a DRAFT ProcurementOrder from the
 * lines — or reject. FULFILLED is set by the order's receive flow when it
 * completes.
 *
 * Both new permissions are resolved for the requisition's own organization,
 * not the caller's active one — a right granted in organization A never
 * approves a request filed in organization B.
 *
 * Notifications deliberately absent — platform-wide pass after this sprint.
 */
@Injectable()
export class PurchaseRequisitionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersPrisma: UsersPrismaService,
    private readonly fileService: FileService,
  ) {}

  // ── Access ────────────────────────────────────────────────────────────────

  private async resolveCtx(userId: number, ctx?: Ctx): Promise<Ctx> {
    if (ctx) return ctx;
    const info = await this.usersPrisma.getUserAccessInfo(userId);
    return { isSuperAdmin: info.isSuperAdmin, permissionNames: info.permissionNames };
  }

  private isProcurement(ctx: Ctx, manage = false) {
    const names = ctx.permissionNames ?? [];
    return (
      !!ctx.isSuperAdmin ||
      names.includes('manage_procurement') ||
      (!manage && names.includes('view_procurement'))
    );
  }

  private async assertCanSee(req: any, userId: number, ctx?: Ctx) {
    if (req.createdBy === userId) return;
    const c = await this.resolveCtx(userId, ctx);
    if (this.isProcurement(c)) return;
    // The organization's approvers read what they are asked to decide on.
    if (req.entityId && (await this.holdsInEntity(userId, req.entityId, APPROVE_PERMISSION))) return;
    throw new ForbiddenException('Դուք այս հայտի հասանելիություն չունեք');
  }

  /**
   * Does the caller hold `permission` — or super-admin — resolved for ONE
   * organization? The route guard resolves against every organization at
   * once, which is fine for "may open this route" but not for "may decide for
   * this organization".
   */
  private async holdsInEntity(userId: number, entityId: number, permission: string): Promise<boolean> {
    const info = await this.usersPrisma.getUserAccessInfo(userId, entityId);
    return info.isSuperAdmin || info.permissionNames.includes(permission);
  }

  private async assertMayFile(userId: number, entityId: number | null) {
    if (!entityId) throw new BadRequestException('Ընտրեք կազմակերպությունը, որի անունից ներկայացնում եք հայտը');
    if (!(await this.holdsInEntity(userId, entityId, CREATE_PERMISSION))) {
      throw new ForbiddenException('Դուք այս կազմակերպությունում գնման հայտ ներկայացնելու թույլտվություն չունեք');
    }
  }

  private async assertMayDecide(req: any, userId: number) {
    if (!req.entityId || !(await this.holdsInEntity(userId, req.entityId, APPROVE_PERMISSION))) {
      throw new ForbiddenException('Դուք այս կազմակերպության գնման հայտերը հաստատելու թույլտվություն չունեք');
    }
    if (req.status !== 'PENDING_APPROVAL') throw new BadRequestException('Հայտը հաստատման սպասման մեջ չէ');
  }

  // ── Lines ─────────────────────────────────────────────────────────────────

  /** Normalise + snapshot lines: catalog picks fill code/unit/stock/expected. */
  private async buildLines(input: LineInput[]) {
    const lines = (input ?? []).map((l) => ({
      itemId: l.itemId ? Number(l.itemId) : null,
      itemName: (l.itemName ?? '').trim(),
      code: l.code?.trim() || null,
      unit: l.unit || null,
      quantity: Number(l.quantity),
      note: l.note?.trim() || null,
    }));
    if (!lines.length) throw new BadRequestException('Ավելացրեք գոնե մեկ ապրանք');
    for (const l of lines) {
      if (!(l.quantity > 0)) throw new BadRequestException('Քանակը պետք է լինի դրական թիվ');
    }
    const itemIds = [...new Set(lines.map((l) => l.itemId).filter((x): x is number => x != null))];
    const items = itemIds.length
      ? await this.prisma.item.findMany({ where: { id: { in: itemIds } } })
      : [];
    const itemOf = new Map(items.map((i) => [i.id, i]));
    for (const l of lines) {
      if (l.itemId && !itemOf.has(l.itemId)) throw new NotFoundException('Ապրանքը չի գտնվել');
    }
    // Expected = ordered-not-received across open orders, per item (#1888).
    const expected = new Map<number, number>();
    if (itemIds.length) {
      const open = await this.prisma.procurementOrderItem.findMany({
        where: { itemId: { in: itemIds }, order: { status: { in: OPEN_ORDER_STATUSES as any } } },
        select: { itemId: true, quantity: true, receivedQuantity: true },
      });
      for (const o of open) {
        expected.set(o.itemId, (expected.get(o.itemId) ?? 0) + Math.max(0, o.quantity - (o.receivedQuantity ?? 0)));
      }
    }
    return lines.map((l) => {
      const item = l.itemId ? itemOf.get(l.itemId) : undefined;
      return {
        ...l,
        itemName: l.itemName || item?.name || '',
        // Generated from the catalog, but the person may have edited it (#9).
        code: l.code ?? item?.code ?? null,
        unit: (l.unit ?? item?.unit ?? null) as any,
        stockQuantity: item ? item.quantity : null,
        expectedQuantity: item ? expected.get(item.id) ?? 0 : null,
      };
    }).map((l) => {
      if (!l.itemName) throw new BadRequestException('Նշեք ապրանքի անվանումը');
      return l;
    });
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async create(
    dto: {
      title?: string;
      comment?: string;
      periodStart?: string;
      periodEnd?: string;
      lines: LineInput[];
      draft?: boolean;
      taskId?: number;
    },
    userId: number,
    entityId: number | null,
  ) {
    await this.assertMayFile(userId, entityId);
    const lines = await this.buildLines(dto.lines);
    this.assertPeriod(dto.periodStart, dto.periodEnd);
    const created = await this.prisma.purchaseRequisition.create({
      data: {
        status: dto.draft ? 'DRAFT' : 'PENDING_APPROVAL',
        title: dto.title?.trim() || null,
        comment: dto.comment?.trim() || null,
        periodStart: dto.periodStart ? new Date(dto.periodStart) : null,
        periodEnd: dto.periodEnd ? new Date(dto.periodEnd) : null,
        entityId: entityId || null,
        createdBy: userId,
        ...(dto.taskId ? { taskId: Number(dto.taskId), taskOrigin: 'ATTACHED' } : {}),
        lines: { create: lines },
      },
    });
    return this.findOne(created.id, userId);
  }

  async update(
    id: number,
    dto: { title?: string; comment?: string; periodStart?: string | null; periodEnd?: string | null; lines?: LineInput[] },
    userId: number,
  ) {
    const req = await this.getOrThrow(id);
    if (req.createdBy !== userId) throw new ForbiddenException('Հայտը կարող է խմբագրել միայն ներկայացնողը');
    if (!EDITABLE.includes(req.status)) throw new BadRequestException('Հայտն այլևս խմբագրելի չէ');
    const lines = dto.lines !== undefined ? await this.buildLines(dto.lines) : undefined;
    const periodStart = dto.periodStart !== undefined ? dto.periodStart : undefined;
    const periodEnd = dto.periodEnd !== undefined ? dto.periodEnd : undefined;
    this.assertPeriod(
      periodStart === undefined ? (req.periodStart?.toISOString() ?? undefined) : periodStart ?? undefined,
      periodEnd === undefined ? (req.periodEnd?.toISOString() ?? undefined) : periodEnd ?? undefined,
    );
    await this.prisma.purchaseRequisition.update({
      where: { id },
      data: {
        ...(dto.title !== undefined ? { title: dto.title?.trim() || null } : {}),
        ...(dto.comment !== undefined ? { comment: dto.comment?.trim() || null } : {}),
        ...(periodStart !== undefined ? { periodStart: periodStart ? new Date(periodStart) : null } : {}),
        ...(periodEnd !== undefined ? { periodEnd: periodEnd ? new Date(periodEnd) : null } : {}),
        ...(lines ? { lines: { deleteMany: {}, create: lines } } : {}),
      },
    });
    return this.findOne(id, userId);
  }

  private assertPeriod(start?: string | null, end?: string | null) {
    if (start && end && new Date(start) > new Date(end)) {
      throw new BadRequestException('Ժամանակահատվածի սկիզբը վերջից ուշ է');
    }
  }

  async findMine(userId: number, query: { status?: string; page?: string; limit?: string }) {
    return this.page({ createdBy: userId, ...(query.status ? { status: query.status as any } : {}) }, query);
  }

  /**
   * Procurement queue: everything the organization has let through. Drafts
   * are the requester's own; PENDING_APPROVAL is the organization's to decide
   * — neither reaches procurement, whatever status filter is asked for.
   */
  async findAll(userId: number, query: { status?: string; page?: string; limit?: string; search?: string }, ctx?: Ctx) {
    const c = await this.resolveCtx(userId, ctx);
    if (!this.isProcurement(c)) throw new ForbiddenException('Դուք գնումների հայտերը դիտելու թույլտվություն չունեք');
    const where: any = query.status && !QUEUE_HIDDEN.includes(query.status)
      ? { status: query.status }
      : { status: { notIn: QUEUE_HIDDEN } };
    if (query.search?.trim()) {
      where.OR = [
        { title: { contains: query.search.trim(), mode: 'insensitive' } },
        { lines: { some: { itemName: { contains: query.search.trim(), mode: 'insensitive' } } } },
      ];
    }
    return this.page(where, query);
  }

  /**
   * The organization's approval desk: every non-draft requisition filed in
   * the caller's active organization, for holders of
   * approve_purchase_requisition there. PENDING_APPROVAL is what needs them;
   * the rest is the history of what they (or procurement) decided.
   */
  async findForApproval(userId: number, entityId: number | null, query: { status?: string; page?: string; limit?: string; search?: string }) {
    if (!entityId || !(await this.holdsInEntity(userId, entityId, APPROVE_PERMISSION))) {
      throw new ForbiddenException('Դուք այս կազմակերպության գնման հայտերը հաստատելու թույլտվություն չունեք');
    }
    const where: any = { entityId, status: query.status ? query.status : { not: 'DRAFT' } };
    if (query.search?.trim()) {
      where.OR = [
        { title: { contains: query.search.trim(), mode: 'insensitive' } },
        { lines: { some: { itemName: { contains: query.search.trim(), mode: 'insensitive' } } } },
      ];
    }
    return this.page(where, query);
  }

  /** #1894: the requisitions attached to / created from a task. */
  async findByTask(taskId: number) {
    const rows = await this.prisma.purchaseRequisition.findMany({
      where: { taskId },
      include: this.include,
      orderBy: { id: 'desc' },
    });
    return this.decorate(rows);
  }

  private async page(where: any, query: { page?: string; limit?: string }) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 20);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.purchaseRequisition.findMany({
        where,
        include: this.include,
        orderBy: { id: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.purchaseRequisition.count({ where }),
    ]);
    return { data: await this.decorate(rows), total, page, limit };
  }

  async findOne(id: number, userId: number, ctx?: Ctx) {
    const req = await this.prisma.purchaseRequisition.findUnique({ where: { id }, include: this.include });
    if (!req) throw new NotFoundException('Հայտը չի գտնվել');
    await this.assertCanSee(req, userId, ctx);
    return (await this.decorate([req]))[0];
  }

  // ── Requester actions ─────────────────────────────────────────────────────

  async submit(id: number, userId: number) {
    const req = await this.getOrThrow(id);
    if (req.createdBy !== userId) throw new ForbiddenException('Հայտը կարող է ուղարկել միայն ներկայացնողը');
    if (req.status !== 'DRAFT') throw new BadRequestException('Հայտն արդեն ուղարկված է');
    await this.assertMayFile(userId, req.entityId);
    await this.prisma.purchaseRequisition.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });
    return this.findOne(id, userId);
  }

  async cancel(id: number, userId: number, isSuperAdmin: boolean) {
    const req = await this.getOrThrow(id);
    if (!isSuperAdmin && req.createdBy !== userId) throw new ForbiddenException('Հայտը կարող է չեղարկել միայն ներկայացնողը');
    if (!CANCELLABLE.includes(req.status)) throw new BadRequestException('Հայտն այլևս հնարավոր չէ չեղարկել');
    await this.prisma.purchaseRequisition.update({ where: { id }, data: { status: 'CANCELLED' } });
    return this.findOne(id, userId, { isSuperAdmin });
  }

  /** #1893/#1894: bind the requisition to a task (created from it, or attached). */
  async setTask(id: number, userId: number, taskId: number | null, origin: 'CREATED' | 'ATTACHED', ctx?: Ctx) {
    const req = await this.getOrThrow(id);
    await this.assertCanSee(req, userId, ctx);
    await this.prisma.purchaseRequisition.update({
      where: { id },
      data: taskId ? { taskId, taskOrigin: origin } : { taskId: null, taskOrigin: null },
    });
    return this.findOne(id, userId, ctx);
  }

  // ── Organization approval (approve_purchase_requisition in the requisition's organization) ──

  /** Let the requisition through to procurement. */
  async orgApprove(id: number, userId: number) {
    const req = await this.getOrThrow(id);
    await this.assertMayDecide(req, userId);
    await this.prisma.purchaseRequisition.update({
      where: { id },
      data: { status: 'SUBMITTED', decidedBy: userId, decidedAt: new Date() },
    });
    return this.findOne(id, userId, { permissionNames: [APPROVE_PERMISSION] });
  }

  /** Turn it down before procurement ever sees it — the reason goes back to the requester. */
  async orgReject(id: number, userId: number, reason?: string) {
    if (!reason?.trim()) throw new BadRequestException('Մերժման պատճառը պարտադիր է');
    const req = await this.getOrThrow(id);
    await this.assertMayDecide(req, userId);
    await this.prisma.purchaseRequisition.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: reason.trim(), decidedBy: userId, decidedAt: new Date() },
    });
    return this.findOne(id, userId, { permissionNames: [APPROVE_PERMISSION] });
  }

  // ── Procurement actions (manage_procurement, guard-checked) ───────────────

  async review(id: number, userId: number) {
    const req = await this.getOrThrow(id);
    if (req.status !== 'SUBMITTED') throw new BadRequestException('Հայտը սպասման մեջ չէ');
    await this.prisma.purchaseRequisition.update({
      where: { id },
      data: { status: 'IN_REVIEW', reviewedBy: userId, reviewedAt: new Date() },
    });
    return this.findOne(id, userId, { permissionNames: ['manage_procurement'] });
  }

  async reject(id: number, userId: number, reason?: string) {
    if (!reason?.trim()) throw new BadRequestException('Մերժման պատճառը պարտադիր է');
    const req = await this.getOrThrow(id);
    if (!REVIEWABLE.includes(req.status)) throw new BadRequestException('Հայտն այլևս մշակման մեջ չէ');
    await this.prisma.purchaseRequisition.update({
      where: { id },
      data: { status: 'REJECTED', rejectionReason: reason.trim(), reviewedBy: userId, reviewedAt: new Date() },
    });
    return this.findOne(id, userId, { permissionNames: ['manage_procurement'] });
  }

  /** Procurement maps a free-text line onto a catalog item before approval. */
  async resolveLine(id: number, lineId: number, userId: number, itemId: number) {
    const req = await this.getOrThrow(id);
    if (!REVIEWABLE.includes(req.status)) throw new BadRequestException('Հայտն այլևս մշակման մեջ չէ');
    const line = await this.prisma.purchaseRequisitionLine.findFirst({ where: { id: lineId, requisitionId: id } });
    if (!line) throw new NotFoundException('Տողը չի գտնվել');
    const item = await this.prisma.item.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException('Ապրանքը չի գտնվել');
    await this.prisma.purchaseRequisitionLine.update({
      where: { id: lineId },
      data: { itemId: item.id, code: item.code ?? line.code, unit: (item.unit ?? line.unit) as any },
    });
    return this.findOne(id, userId, { permissionNames: ['manage_procurement'] });
  }

  /**
   * Approve = convert: raise a DRAFT ProcurementOrder from the lines (every
   * line must be resolved to a catalog item — an order can't carry free text)
   * and link it. Procurement then adds supplier/prices on the order as usual.
   */
  async approve(id: number, userId: number) {
    const req = await this.prisma.purchaseRequisition.findUnique({ where: { id }, include: { lines: true } });
    if (!req) throw new NotFoundException('Հայտը չի գտնվել');
    if (!REVIEWABLE.includes(req.status)) throw new BadRequestException('Հայտն այլևս մշակման մեջ չէ');
    const unresolved = req.lines.filter((l) => !l.itemId);
    if (unresolved.length) {
      throw new BadRequestException(
        `Նախ ընտրեք կատալոգի ապրանքը հետևյալ տողերի համար՝ ${unresolved.map((l) => l.itemName).join(', ')}`,
      );
    }
    // One order line per item — merge duplicates.
    const byItem = new Map<number, number>();
    for (const l of req.lines) byItem.set(l.itemId!, (byItem.get(l.itemId!) ?? 0) + l.quantity);

    const result = await this.prisma.$transaction(async (tx) => {
      const order = await tx.procurementOrder.create({
        data: {
          createdBy: userId,
          // The purchase is for the organization that asked for it, so the
          // order — and the finance transfers it raises — file there.
          entityId: req.entityId ?? null,
          notes: `Գնման հայտ #${req.id}${req.title ? ` — ${req.title}` : ''}`,
          items: { create: [...byItem].map(([itemId, quantity]) => ({ itemId, quantity })) },
        },
      });
      await tx.purchaseRequisition.update({
        where: { id },
        data: { status: 'APPROVED', orderId: order.id, reviewedBy: userId, reviewedAt: new Date() },
      });
      return order;
    });
    const out = await this.findOne(id, userId, { permissionNames: ['manage_procurement'] });
    return { ...out, order: { id: result.id, status: result.status } };
  }

  /** Called by the procurement receive flow when an order completes. */
  async markFulfilledForOrder(orderId: number) {
    await this.prisma.purchaseRequisition.updateMany({
      where: { orderId, status: 'APPROVED' },
      data: { status: 'FULFILLED' },
    });
  }

  // ── Comments + attachments ────────────────────────────────────────────────

  async addComment(id: number, userId: number, text: string, ctx?: Ctx) {
    if (!text?.trim()) throw new BadRequestException('Մեկնաբանությունը դատարկ է');
    const req = await this.getOrThrow(id);
    await this.assertCanSee(req, userId, ctx);
    await this.prisma.purchaseRequisitionComment.create({ data: { requisitionId: id, userId, text: text.trim() } });
    return this.findOne(id, userId, ctx);
  }

  async addAttachment(id: number, userId: number, file: Express.Multer.File, ctx?: Ctx) {
    const req = await this.getOrThrow(id);
    await this.assertCanSee(req, userId, ctx);
    if (!file) throw new BadRequestException('Ֆայլը բացակայում է');
    const url = this.fileService.upload(file);
    await this.prisma.purchaseRequisitionAttachment.create({
      data: {
        requisitionId: id,
        uploadedBy: userId,
        name: Buffer.from(file.originalname, 'latin1').toString('utf8'),
        url,
        size: file.size,
        mimeType: file.mimetype,
      },
    });
    return this.findOne(id, userId, ctx);
  }

  async deleteAttachment(id: number, attachmentId: number, userId: number) {
    const att = await this.prisma.purchaseRequisitionAttachment.findFirst({ where: { id: attachmentId, requisitionId: id } });
    if (!att) throw new NotFoundException('Ֆայլը չի գտնվել');
    if (att.uploadedBy !== userId) throw new ForbiddenException('Ֆայլը կարող է ջնջել միայն կցողը');
    await this.prisma.purchaseRequisitionAttachment.delete({ where: { id: attachmentId } });
    return { success: true };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private get include() {
    return {
      lines: { include: { item: { select: { id: true, name: true, code: true, unit: true, quantity: true } } }, orderBy: { id: 'asc' as const } },
      comments: { orderBy: { createdAt: 'asc' as const } },
      attachments: true,
      order: { select: { id: true, status: true, supplierId: true } },
    };
  }

  private async getOrThrow(id: number) {
    const req = await this.prisma.purchaseRequisition.findUnique({ where: { id } });
    if (!req) throw new NotFoundException('Հայտը չի գտնվել');
    return req;
  }

  private async decorate(rows: any[]) {
    const ids = [...new Set(rows.flatMap((r) => [r.createdBy, r.reviewedBy, r.decidedBy, ...(r.comments ?? []).map((c: any) => c.userId)]).filter((x): x is number => x != null))];
    const users = ids.length ? await this.usersPrisma.getUsersByIds(ids) : [];
    const nameOf = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return rows.map((r) => ({
      ...r,
      createdByName: nameOf.get(r.createdBy) ?? null,
      reviewedByName: r.reviewedBy ? nameOf.get(r.reviewedBy) ?? null : null,
      decidedByName: r.decidedBy ? nameOf.get(r.decidedBy) ?? null : null,
      comments: (r.comments ?? []).map((c: any) => ({ ...c, authorName: nameOf.get(c.userId) ?? null })),
    }));
  }
}
