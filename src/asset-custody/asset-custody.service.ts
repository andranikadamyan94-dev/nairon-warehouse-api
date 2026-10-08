import { requireInternalSecret } from '../common/internal-headers';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { UsersPrismaService } from '../common/users-prisma.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from '../common/notifications/notifications.service';
import { CreateAssetRequestDto, DirectIssueDto, IssueAssetRequestDto, ObjectIssueDto, ReassignCustodyDto, ReleaseCondition, ReturnCustodyDto } from './dto/asset-custody.dto';
import { ObjectsService } from '../objects/objects.service';
import { holdsObjectRight, isResponsibleOf, OBJECT_PAGE_RIGHT } from '../objects/object-page-rights';
import { TxClient } from '../common/operations/operations.service';

/**
 * Asset custody (2026-09-23, owner's decisions in
 * snapshots/asset-custody-design-2026-09-23.md).
 *
 * A person asks for an asset with no end date (a laptop, a chair): the request
 * is approved by a permission holder, the warehouse issues a concrete asset,
 * the person confirms receipt, and one day returns it with its condition.
 * Every hand-over is one AssetCustody row; the asset's `responsibleUserId`
 * mirrors the live person holder so the older screens keep working.
 */
export const PERM = {
  request: 'request_assets',
  approve: 'approve_asset_requests',
  issue: 'issue_assets',
  view: 'view_asset_custody',
} as const;

type Actor = { userId: number; isSuperAdmin: boolean; permissions: string[] };

const custodyInclude = {
  asset: { include: { item: true, warehouse: true } },
  request: true,
} as const;

@Injectable()
export class AssetCustodyService {
  private readonly logger = new Logger(AssetCustodyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usersPrisma: UsersPrismaService,
    private readonly notifications: WarehouseNotificationsService,
    private readonly objects: ObjectsService,
  ) {}

  private has(actor: Actor, ...perms: string[]) {
    return actor.isSuperAdmin || perms.some((p) => actor.permissions.includes(p));
  }

  private async person(userId: number) {
    const [u] = await this.usersPrisma.getUsersByIds([userId]);
    return u ? `${u.firstName} ${u.lastName}`.trim() : `#${userId}`;
  }

  // ── Requests ──────────────────────────────────────────────────────────────

  /**
   * Everything createRequest() checks before it writes, in its order: the
   * object (only its responsible person asks for it), who the asset is for, the
   * item, the person. Shared with the assistant's preflight so the two cannot
   * drift.
   *
   * A request on somebody else's behalf needs the approve or issue right, and
   * a person who exists and is active — the users database says (filterActive).
   * It needs neither a selected organisation nor that person's HR membership
   * in it: the 2026-10-03 rule asking HR's org tree (members/internal) was
   * withdrawn on 2026-10-05 with "the warehouse is global" — the warehouse
   * client has no organisation picker, and a colleague of another
   * organisation is as real a holder as one's own. `entityId` is only what
   * the row is stamped with.
   */
  private async assertMayRequest(dto: CreateAssetRequestDto, actor: Actor) {
    const forObject = dto.forObjectId ? await this.objects.crmObject(dto.forObjectId) : null;
    if (dto.forObjectId && !forObject) throw new NotFoundException('Օբյեկտը չի գտնվել');
    // Owner 2026-09-29: only the object's responsible person asks on its behalf (fresh from CRM, not the cache).
    if (forObject) {
      const fresh = await this.objects.crmObjectFresh(forObject.id);
      if (!fresh?.responsibleId) throw new BadRequestException('Օբյեկտը պատասխանատու չունի');
      if (fresh.responsibleId !== actor.userId) throw new ForbiddenException('Օբյեկտի համար հայտ ներկայացնում է միայն օբյեկտի պատասխանատուն');
    }
    const forUserId: number | null = forObject ? null : dto.forUserId ?? actor.userId;
    // Asking for yourself needs the request permission; asking on someone
    // else's behalf (HR at onboarding, a head) needs approve or issue rights.
    if (forUserId && forUserId !== actor.userId && !this.has(actor, PERM.approve, PERM.issue)) {
      throw new ForbiddenException('Ուրիշի համար հայտ ներկայացնելու իրավունք չկա');
    }
    const item = await this.prisma.item.findUnique({ where: { id: dto.itemId } });
    if (!item) throw new NotFoundException('Ռեսուրսը չի գտնվել');
    if (item.type !== 'ASSET') throw new BadRequestException('Հայտ կարելի է ներկայացնել միայն ակտիվների համար');
    // The person exists and is active — the users database, queried directly
    // (filterActive), so somebody offboarded a moment ago is already gone.
    if (forUserId && !(await this.usersPrisma.filterActive([forUserId])).length) {
      throw new BadRequestException('Աշխատակիցը չի գտնվել կամ ապաակտիվացված է');
    }
    return { forObject, forUserId, item };
  }

  async createRequest(dto: CreateAssetRequestDto, actor: Actor, entityId: number | null) {
    const request = await this.fileRequest(dto, actor, entityId);
    this.announceRequest(request);
    return request;
  }

  /**
   * The checks and the row, nothing announced. `tx` lets a caller commit the
   * row together with its own bookkeeping (OperationsService: one request per
   * Idempotency-Key); announceRequest() is then called once, after the commit.
   */
  async fileRequest(dto: CreateAssetRequestDto, actor: Actor, entityId: number | null, tx?: TxClient) {
    const { forObject, forUserId } = await this.assertMayRequest(dto, actor);
    return (tx ?? this.prisma).assetRequest.create({
      data: {
        kind: forObject ? 'OBJECT' : 'PERSONAL',
        entityId: entityId ?? null,
        requestedBy: actor.userId,
        forUserId,
        forObjectId: forObject?.id ?? null,
        itemId: dto.itemId,
        quantity: dto.quantity ?? 1,
        reason: dto.reason?.trim() || null,
      },
      include: { item: true },
    });
  }

  /** Approvers hear of a new request (fire-and-forget, as before). */
  announceRequest(request: { id: number; requestedBy?: number | null; entityId: number | null; forObjectId: number | null; forUserId: number | null; quantity: number; reason: string | null; item: { name: string } }) {
    void (async () => {
      const object = request.forObjectId ? await this.objects.crmObject(request.forObjectId) : null;
      const who = object ? `${object.code} ${object.name}` : await this.person(request.forUserId!);
      await this.notifications.send({
        type: WAREHOUSE_TYPES.assetRequest,
        permissions: [PERM.approve],
        entityIds: [request.entityId],
        actorId: request.requestedBy ?? null,
        title: 'Նոր գույքի հայտ',
        body: `${who}՝ ${request.item.name} × ${request.quantity}${request.reason ? ` — ${request.reason}` : ''}`,
        path: '/assets?tab=custody&view=requests',
        details: [{ label: 'Հայտ', value: `#${request.id}` }],
      });
    })().catch((e: any) => this.logger.warn(`asset request notification failed: ${e?.message ?? e}`));
  }

  async listRequests(query: { status?: string; forUserId?: number; forObjectId?: number; mine?: boolean }, actor: Actor) {
    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.forUserId) where.forUserId = query.forUserId;
    if (query.forObjectId) {
      // An object's requests: the CRM object page's «Պահեստային հայտեր» tab —
      // its own right, the object's responsible person, or a super admin
      // (owner 2026-10-05). The warehouse client never filters by object.
      await this.assertMayReadObjectTab(Number(query.forObjectId), actor, OBJECT_PAGE_RIGHT.requests, 'Օբյեկտի հայտերը դիտելու իրավունք չկա');
      where.forObjectId = Number(query.forObjectId);
      return this.prisma.assetRequest.findMany({
        where,
        include: { item: true, custodies: { include: { asset: true } } },
        orderBy: { createdAt: 'desc' },
      });
    }
    if (query.mine || !this.has(actor, PERM.approve, PERM.issue, PERM.view)) {
      where.OR = [{ requestedBy: actor.userId }, { forUserId: actor.userId }];
    }
    return this.prisma.assetRequest.findMany({
      where,
      include: { item: true, custodies: { include: { asset: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  private async requestOr404(id: number) {
    const r = await this.prisma.assetRequest.findUnique({ where: { id }, include: { item: true, custodies: true } });
    if (!r) throw new NotFoundException('Հայտը չի գտնվել');
    return r;
  }

  async decide(id: number, approve: boolean, note: string | undefined, actor: Actor) {
    const r = await this.requestOr404(id);
    if (r.status !== 'PENDING') throw new BadRequestException('Հայտն արդեն որոշված է');
    const updated = await this.prisma.assetRequest.update({
      where: { id },
      data: { status: approve ? 'APPROVED' : 'REJECTED', decidedBy: actor.userId, decidedAt: new Date(), decisionNote: note?.trim() || null },
      include: { item: true },
    });
    void this.notifyUsers([r.requestedBy, r.forUserId].filter((x): x is number => !!x), {
      type: WAREHOUSE_TYPES.assetDecided,
      actorId: actor.userId,
      title: approve ? 'Գույքի հայտը հաստատվեց' : 'Գույքի հայտը մերժվեց',
      body: `${r.item.name} × ${r.quantity}${note ? ` — ${note}` : ''}`,
      path: '/profile?tab=assets',
    });
    if (approve) {
      // Phase 2: the object by its code and name, as the request announcement names it.
      const object = r.forObjectId ? await this.objects.crmObject(r.forObjectId).catch(() => null) : null;
      const who = r.forObjectId
        ? object ? `${object.code} ${object.name}` : `Օբյեկտ #${r.forObjectId}`
        : await this.person(r.forUserId ?? r.requestedBy);
      void this.notifications.send({
        type: WAREHOUSE_TYPES.assetToIssue,
        permissions: [PERM.issue],
        entityIds: [r.entityId],
        actorId: actor.userId,
        title: 'Հաստատված գույքի հայտ՝ տրամադրման',
        body: `${who}՝ ${r.item.name} × ${r.quantity}`,
        path: '/assets?tab=custody&view=requests',
        details: [{ label: 'Հայտ', value: `#${r.id}` }],
      });
    }
    return updated;
  }

  /** What cancel() checks before it writes. Shared with the assistant's preflight. */
  private async cancellable(id: number, actor: Actor) {
    const r = await this.requestOr404(id);
    if (r.requestedBy !== actor.userId && !actor.isSuperAdmin) throw new ForbiddenException();
    if (!['PENDING', 'APPROVED'].includes(r.status)) throw new BadRequestException('Հայտն այլևս հնարավոր չէ չեղարկել');
    return r;
  }

  async cancel(id: number, actor: Actor) {
    const r = await this.cancellable(id, actor);
    const updated = await this.prisma.assetRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
    void this.announceRequestCancelled(r, actor);
    return updated;
  }

  /**
   * Phase 3 (2026-10-07): a withdrawn request reaches the people it was
   * waiting on — approvers while PENDING, issuers once APPROVED — and the
   * person it was for (forUserId), or its filer when a super-admin withdrew it.
   */
  private async announceRequestCancelled(r: any, actor: Actor) {
    try {
      const object = r.forObjectId ? await this.objects.crmObject(r.forObjectId).catch(() => null) : null;
      const who = r.forObjectId
        ? object ? `${object.code} ${object.name}` : `Օբյեկտ #${r.forObjectId}`
        : await this.person(r.forUserId ?? r.requestedBy);
      const n = {
        type: WAREHOUSE_TYPES.assetRequestCancelled,
        actorId: actor.userId,
        title: 'Գույքի հայտը չեղարկվել է',
        body: `${who}՝ ${r.item?.name ?? 'գույք'} × ${r.quantity} — հայտը չեղարկվել է։`,
        details: [{ label: 'Հայտ', value: `#${r.id}` }],
      };
      // The people it concerned see it on their profile; the desk on its register.
      const named = [r.forUserId, r.requestedBy].filter((x): x is number => !!x);
      await this.notifications.sendToUsers(named, { ...n, path: '/profile?tab=assets' });
      await this.notifications.send({
        ...n,
        permissions: [r.status === 'APPROVED' ? PERM.issue : PERM.approve],
        entityIds: [r.entityId],
        excludeUserIds: named,
        path: '/assets?tab=custody&view=requests',
      });
    } catch (e: any) {
      this.logger.warn(`asset request cancel notification failed: ${e?.message ?? e}`);
    }
  }

  // ── The assistant's preflights (2026-10-01, coverage gaps batch 4) ──────────
  //
  // «Նոր հայտ» for oneself and «Չեղարկել» one's own request, as the screen
  // offers them — each the mutation's own check, nothing written, nobody told.
  // Narrower than the screen, on purpose (the owner's rules for AI writes):
  //
  //   for oneself     a request on somebody else's behalf, or for an object,
  //                   stays on the screen;
  //   literal right   a super-admin flag does not stand in for request_assets
  //                   (or approve / issue, which the route also admits);
  //   one workspace   a request is filed in the organization being worked in;
  //   own only        only the person who filed a request withdraws it here —
  //                   whatever organisation the browser has selected (owner,
  //                   2026-10-05: "your own" is requestedBy alone).
  //
  // Each answers what a confirmation card needs; cancel also `material`, the
  // state an agreement is pinned to (any decision or issue moves updatedAt).

  async previewRequest(dto: CreateAssetRequestDto, actor: Actor, entityId: number | null) {
    if (!entityId) throw new BadRequestException('Ընտրեք կազմակերպությունը');
    if (dto.forObjectId || (dto.forUserId && dto.forUserId !== actor.userId)) {
      throw new BadRequestException('Օգնականի միջոցով գույքի հայտը ներկայացվում է միայն Ձեզ համար. ուրիշի կամ օբյեկտի համար՝ «Հայտեր» էջից');
    }
    if (![PERM.request, PERM.approve, PERM.issue].some((p) => actor.permissions.includes(p))) {
      throw new ForbiddenException('Դուք այս կազմակերպությունում գույքի հայտ ներկայացնելու թույլտվություն չունեք');
    }
    const { item, forUserId } = await this.assertMayRequest(dto, actor);
    // The person's requests for the same item still open — a second one is often a mistake.
    const open = await this.prisma.assetRequest.count({
      where: { requestedBy: actor.userId, itemId: item.id, status: { in: ['PENDING', 'APPROVED'] } },
    });
    return {
      request: {
        kind: 'PERSONAL' as const,
        item: { id: item.id, name: item.name, code: item.code ?? null, unit: item.unit ?? null },
        quantity: dto.quantity ?? 1,
        reason: dto.reason?.trim() || null,
        forUser: { id: forUserId!, name: await this.person(forUserId!) },
        entityId,
        openForSameItem: open,
      },
    };
  }

  async previewCancelRequest(id: number, actor: Actor) {
    const r = await this.requestOr404(id);
    if (r.requestedBy !== actor.userId) throw new ForbiddenException('Օգնականի միջոցով կարելի է չեղարկել միայն Ձեր ներկայացրած հայտը');
    const req = await this.cancellable(id, actor);
    return {
      from: req.status,
      to: 'CANCELLED' as const,
      request: {
        id: req.id,
        item: { id: req.item.id, name: req.item.name, unit: req.item.unit ?? null },
        quantity: req.quantity,
        reason: req.reason,
        status: req.status,
        forUser: req.forUserId ? { id: req.forUserId, name: await this.person(req.forUserId) } : null,
        // Already handed out against it: cancelling does not take them back.
        issuedOpen: req.custodies.filter((c) => !c.releasedAt).length,
        createdAt: req.createdAt.toISOString(),
        material: {
          requestId: req.id,
          status: req.status,
          requestedBy: req.requestedBy,
          entityId: req.entityId ?? null,
          updatedAt: req.updatedAt.toISOString(),
        },
      },
    };
  }

  /** The warehouse hands out concrete assets against an approved request. */
  async issue(id: number, dto: IssueAssetRequestDto, actor: Actor) {
    const r = await this.requestOr404(id);
    if (r.status !== 'APPROVED') throw new BadRequestException('Միայն հաստատված հայտի դիմաց կարելի է տրամադրել');
    if (!r.forUserId && !r.forObjectId) throw new BadRequestException('Հայտը ստացող չունի');
    const already = r.custodies.filter((c) => !c.releasedAt).length;
    if (already + dto.assetIds.length > r.quantity) {
      throw new BadRequestException(`Հայտով նախատեսված է ${r.quantity} միավոր, արդեն տրամադրված է ${already}`);
    }
    const rows = [];
    for (const assetId of dto.assetIds) {
      rows.push(
        r.forObjectId
          ? await this.handOverToObject(assetId, r.forObjectId, actor.userId, { requestId: r.id, itemId: r.itemId, notes: dto.notes })
          : await this.handOver(assetId, r.forUserId!, actor.userId, { via: 'PERSONAL_REQUEST', requestId: r.id, itemId: r.itemId, notes: dto.notes }),
      );
    }
    if (already + dto.assetIds.length >= r.quantity) {
      await this.prisma.assetRequest.update({ where: { id }, data: { status: 'ISSUED' } });
    }
    if (r.forUserId) {
      void this.notifyUsers([r.forUserId], {
        type: WAREHOUSE_TYPES.assetIssued,
      actorId: actor.userId,
        title: 'Ձեզ գույք է տրամադրվել',
        body: `${r.item.name} × ${dto.assetIds.length} — հաստատեք ստացումը`,
        path: '/profile?tab=assets',
      });
    } else if (r.forObjectId) {
      void this.notifyObjectResponsible(r.forObjectId, `${r.item.name} × ${dto.assetIds.length}`);
    }
    return rows;
  }

  // ── Objects as holders (phase 2) ──────────────────────────────────────────

  /** The warehouse gives an asset to a construction object for good — no return path. */
  async directIssueToObject(dto: ObjectIssueDto, actor: Actor) {
    const row = await this.handOverToObject(dto.assetId, dto.objectId, actor.userId, { notes: dto.notes });
    void this.notifyObjectResponsible(dto.objectId, `${row.asset.item.name}${row.asset.serialNumber ? ` (${row.asset.serialNumber})` : ''}`);
    return row;
  }

  private async handOverToObject(assetId: number, objectId: number, assignedBy: number, opts: { requestId?: number; itemId?: number; notes?: string }) {
    const object = await this.objects.crmObject(objectId);
    if (!object) throw new NotFoundException('Օբյեկտը չի գտնվել');
    await this.assertFree(assetId, opts.itemId);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.assetCustody.create({
        data: {
          assetId,
          holderType: 'OBJECT',
          holderObjectId: objectId,
          originObjectId: objectId,
          via: opts.requestId ? 'PERSONAL_REQUEST' : 'DIRECT_ISSUE',
          requestId: opts.requestId ?? null,
          assignedBy,
          // Owner 2026-09-29: the object's responsible person confirms receipt (see accept()).
          acceptedAt: null,
          notes: opts.notes?.trim() || null,
        },
        include: custodyInclude,
      });
      await tx.asset.update({ where: { id: assetId }, data: { responsibleUserId: null } });
      return row;
    });
  }

  /**
   * Object requests through the catalog (owner 2026-10-08): a unit allocated to
   * a reservation that carries an object goes to the OBJECT exactly as the old
   * object asset-request hand-over put it there — holderType OBJECT, the
   * object as origin, receipt still the responsible person's (accept()). The
   * unit leaves whoever held it (a person's open custody is closed, as
   * reassign closes the previous holder's) and the asset's responsible mirror
   * is cleared. Runs inside the allocation's transaction; the caller has
   * already checked the asset is AVAILABLE and of the reservation's item.
   */
  async handOverToObjectInTx(tx: any, input: { assetId: number; objectId: number; reservationId: number; assignedBy?: number | null; notes?: string | null }) {
    await tx.assetCustody.updateMany({
      where: { assetId: input.assetId, releasedAt: null },
      data: { releasedAt: new Date(), releasedBy: input.assignedBy ?? null },
    });
    const row = await tx.assetCustody.create({
      data: {
        assetId: input.assetId,
        holderType: 'OBJECT',
        holderObjectId: input.objectId,
        originObjectId: input.objectId,
        via: 'TASK_ALLOCATION',
        reservationId: input.reservationId,
        assignedBy: input.assignedBy ?? null,
        acceptedAt: null,
        notes: input.notes?.trim() || null,
      },
    });
    await tx.asset.update({ where: { id: input.assetId }, data: { responsibleUserId: null } });
    return row;
  }

  /**
   * The allocation that put a unit at an object is released (cancelled,
   * reclaimed, reallocated, released by hand): the object's custody row closes
   * the same way the old flow closed it — dated, by whom, condition OK. Rows
   * the allocation did not make (a direct issue to the object) are left alone.
   */
  async closeObjectCustodyInTx(tx: any, input: { assetId: number | null | undefined; reservationId: number; releasedBy?: number | null }) {
    if (!input.assetId) return 0;
    const { count } = await tx.assetCustody.updateMany({
      where: { assetId: input.assetId, reservationId: input.reservationId, holderType: 'OBJECT', releasedAt: null },
      data: { releasedAt: new Date(), releasedBy: input.releasedBy ?? null, releaseCondition: 'OK' },
    });
    return count as number;
  }

  /**
   * The object's manager (its responsible person in the CRM) or the warehouse
   * hands an asset the object holds to a person. The asset keeps its object:
   * the person's return goes back to the object, not to the warehouse.
   */
  async reassign(id: number, dto: ReassignCustodyDto, actor: Actor) {
    const c = await this.prisma.assetCustody.findUnique({ where: { id }, include: custodyInclude });
    if (!c) throw new NotFoundException('Գրառումը չի գտնվել');
    if (c.releasedAt || c.holderType !== 'OBJECT' || !c.holderObjectId) throw new BadRequestException('Միայն օբյեկտի մոտ գտնվող գույքը կարելի է վերաբաշխել');
    const object = await this.objects.crmObject(c.holderObjectId);
    const isManager = object?.responsibleId != null && object.responsibleId === actor.userId;
    if (!isManager && !this.has(actor, PERM.issue)) throw new ForbiddenException('Վերաբաշխում է օբյեկտի պատասխանատուն կամ պահեստը');
    if (await this.usersPrisma.isDeactivated(dto.holderUserId)) throw new BadRequestException('Աշխատակիցն ապաակտիվացված է');
    // 2026-09-29 (owner): only to someone who is or was on the object's tasks.
    // CRM decides who that is; unreachable → refused (fail closed).
    let people: number[];
    try {
      const crmUrl = process.env.CRM_API_URL || 'http://localhost:3003';
      const res = await fetch(`${crmUrl}/api/construction-objects/internal/${c.holderObjectId}/people`, {
        headers: { 'x-internal-secret': requireInternalSecret() },
      });
      if (!res.ok) throw new Error(String(res.status));
      people = ((await res.json()) as any)?.userIds ?? [];
    } catch {
      throw new BadRequestException('Օբյեկտի աշխատակիցների ցանկը հասանելի չէ — փորձեք կրկին');
    }
    if (!people.includes(dto.holderUserId)) throw new BadRequestException('Գույքը կարելի է տալ միայն նախագծի առաջադրանքներում աշխատած աշխատակցին');
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.assetCustody.update({ where: { id }, data: { releasedAt: new Date(), releasedBy: actor.userId } });
      const next = await tx.assetCustody.create({
        data: {
          assetId: c.assetId,
          holderType: 'USER',
          holderUserId: dto.holderUserId,
          originObjectId: c.holderObjectId,
          via: 'OBJECT_REASSIGN',
          assignedBy: actor.userId,
          notes: dto.notes?.trim() || null,
        },
        include: custodyInclude,
      });
      await tx.asset.update({ where: { id: c.assetId }, data: { responsibleUserId: dto.holderUserId } });
      return next;
    });
    void this.notifyUsers([dto.holderUserId], {
      type: WAREHOUSE_TYPES.assetIssued,
      actorId: actor.userId,
      title: 'Ձեզ գույք է տրամադրվել',
      body: `${row.asset.item.name}${row.asset.serialNumber ? ` (${row.asset.serialNumber})` : ''} — ${object ? `${object.code} ${object.name}` : 'օբյեկտ'} · հաստատեք ստացումը`,
      path: '/profile?tab=assets',
    });
    return row;
  }

  /**
   * May this person read one object's tab of the CRM object page (owner
   * decision 2026-10-05, objects/object-page-rights.ts)? The tab's own right
   * or a super admin — decided here, nothing asked; otherwise the object's
   * responsible person, as CRM's internal card names them (the «Գույք» tab is
   * where they confirm receipt, «Պահեստային հայտեր» where they ask). The
   * custody rights (view / issue / approve) do NOT open an object's reads any
   * more; they keep the register. The warehouse is global: no organisation is
   * consulted, and CRM's catalogue cache is not either. CRM unreachable, or
   * no such object, is "not the responsible person" — 403, never a guess.
   */
  private async assertMayReadObjectTab(objectId: number, actor: Actor, right: string, refusal: string): Promise<void> {
    if (holdsObjectRight(actor.permissions, actor.isSuperAdmin, right)) return;
    const card = await this.objects.card(objectId).catch(() => null);
    if (isResponsibleOf(card, actor.userId)) return;
    throw new ForbiddenException(refusal);
  }

  /** What an object holds: GET /custody/object/:objectId and GET /custody?holderObjectId=. */
  async assertMayReadObject(objectId: number, actor: Actor): Promise<void> {
    await this.assertMayReadObjectTab(objectId, actor, OBJECT_PAGE_RIGHT.assets, 'Օբյեկտի գույքը դիտելու իրավունք չկա');
  }

  async forObject(objectId: number, actor: Actor) {
    await this.assertMayReadObject(objectId, actor);
    const rows = await this.prisma.assetCustody.findMany({
      where: { OR: [{ holderObjectId: objectId }, { originObjectId: objectId }] },
      include: custodyInclude,
      orderBy: { assignedAt: 'desc' },
    });
    // The CRM page has no user directory of the warehouse's shape: name the holders here.
    const ids = [...new Set(rows.map((r) => r.holderUserId).filter((x): x is number => !!x))];
    const users = ids.length ? await this.usersPrisma.getUsersByIds(ids) : [];
    const name = new Map(users.map((u) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    return rows.map((r) => ({ ...r, holderName: r.holderUserId ? name.get(r.holderUserId) ?? `#${r.holderUserId}` : null }));
  }

  private async notifyObjectResponsible(objectId: number, what: string) {
    try {
      const object = await this.objects.crmObject(objectId);
      if (object?.responsibleId) {
        await this.notifications.sendToUsers([object.responsibleId], {
          type: WAREHOUSE_TYPES.assetIssuedObject,
          title: 'Օբյեկտին գույք է տրամադրվել',
          body: `${object.code} ${object.name}՝ ${what}`,
          path: `/objects/${objectId}`,
        });
      }
    } catch (e: any) {
      this.logger.warn(`object notification failed: ${e?.message ?? e}`);
    }
  }

  private async assertFree(assetId: number, itemId?: number) {
    const asset = await this.prisma.asset.findUnique({ where: { id: assetId }, include: { item: true } });
    if (!asset) throw new NotFoundException(`Ակտիվ #${assetId} չի գտնվել`);
    if (itemId && asset.itemId !== itemId) throw new BadRequestException(`Ակտիվ #${assetId}-ը հայտի ռեսուրսից չէ`);
    if (asset.status !== 'AVAILABLE') throw new BadRequestException(`Ակտիվ #${assetId}-ը հասանելի չէ (${asset.status})`);
    const open = await this.prisma.assetCustody.findFirst({ where: { assetId, releasedAt: null } });
    if (open) throw new BadRequestException(`Ակտիվ #${assetId}-ն արդեն տրամադրված է`);
    const allocated = await this.prisma.reservationAllocation.findFirst({ where: { assetId, releasedAt: null } });
    if (allocated) throw new BadRequestException(`Ակտիվ #${assetId}-ը տրամադրված է առաջադրանքի`);
    return asset;
  }

  // ── Custody ───────────────────────────────────────────────────────────────

  /** Direct hand-over by the warehouse, no request. */
  async directIssue(dto: DirectIssueDto, actor: Actor) {
    if (await this.usersPrisma.isDeactivated(dto.holderUserId)) throw new BadRequestException('Աշխատակիցն ապաակտիվացված է');
    const row = await this.handOver(dto.assetId, dto.holderUserId, actor.userId, { via: 'DIRECT_ISSUE', notes: dto.notes });
    void this.notifyUsers([dto.holderUserId], {
      type: WAREHOUSE_TYPES.assetIssued,
      actorId: actor.userId,
      title: 'Ձեզ գույք է տրամադրվել',
      body: `${row.asset.item.name}${row.asset.serialNumber ? ` (${row.asset.serialNumber})` : ''} — հաստատեք ստացումը`,
      path: '/profile?tab=assets',
    });
    return row;
  }

  private async handOver(
    assetId: number,
    holderUserId: number,
    assignedBy: number,
    opts: { via: 'PERSONAL_REQUEST' | 'DIRECT_ISSUE'; requestId?: number; itemId?: number; notes?: string },
  ) {
    await this.assertFree(assetId, opts.itemId);

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.assetCustody.create({
        data: {
          assetId,
          holderType: 'USER',
          holderUserId,
          via: opts.via,
          requestId: opts.requestId ?? null,
          assignedBy,
          notes: opts.notes?.trim() || null,
        },
        include: custodyInclude,
      });
      await tx.asset.update({ where: { id: assetId }, data: { responsibleUserId: holderUserId } });
      return row;
    });
  }

  async accept(id: number, actor: Actor) {
    const c = await this.prisma.assetCustody.findUnique({ where: { id }, include: custodyInclude });
    if (!c) throw new NotFoundException('Գրառումը չի գտնվել');
    if (c.holderType === 'OBJECT' && c.holderObjectId) {
      // An object's asset: its responsible person confirms (fresh from CRM).
      const o = await this.objects.crmObjectFresh(c.holderObjectId);
      if (!actor.isSuperAdmin && o?.responsibleId !== actor.userId) throw new ForbiddenException('Ստացումը հաստատում է օբյեկտի պատասխանատուն');
    } else if (c.holderUserId !== actor.userId) throw new ForbiddenException('Ստացումը հաստատում է միայն ստացողը');
    if (c.releasedAt) throw new BadRequestException('Գույքն արդեն վերադարձված է');
    if (c.acceptedAt) return c;
    const accepted = await this.prisma.assetCustody.update({ where: { id }, data: { acceptedAt: new Date() }, include: custodyInclude });
    // Phase 3 (2026-10-07): the person who issued it hears the receipt was confirmed.
    if (c.assignedBy) {
      const what = `${c.asset?.item?.name ?? 'Գույք'}${c.asset?.serialNumber ? ` (${c.asset.serialNumber})` : ''}`;
      const holder = c.holderType === 'OBJECT' && c.holderObjectId
        ? await this.objects.crmObject(c.holderObjectId).then((o) => (o ? `${o.code} ${o.name}` : `Օբյեկտ #${c.holderObjectId}`)).catch(() => `Օբյեկտ #${c.holderObjectId}`)
        : await this.person(c.holderUserId ?? actor.userId).catch(() => '');
      void this.notifyUsers([c.assignedBy], {
        type: WAREHOUSE_TYPES.receiptConfirmed,
        actorId: actor.userId,
        title: 'Գույքի ստացումը հաստատվել է',
        body: `${what}${holder ? ` — ${holder}` : ''} · ստացումը հաստատված է։`,
        path: '/assets?tab=custody',
      });
    }
    return accepted;
  }

  async release(id: number, dto: ReturnCustodyDto, actor: Actor) {
    const c = await this.prisma.assetCustody.findUnique({ where: { id }, include: custodyInclude });
    if (!c) throw new NotFoundException('Գրառումը չի գտնվել');
    if (c.releasedAt) throw new BadRequestException('Գույքն արդեն վերադարձված է');
    if (c.holderUserId !== actor.userId && !this.has(actor, PERM.issue)) {
      throw new ForbiddenException('Վերադարձը գրանցում է ստացողը կամ պահեստը');
    }
    if (c.holderType === 'OBJECT') throw new BadRequestException('Օբյեկտին տրված գույքը պահեստ չի վերադառնում');
    // The responsible person cannot walk away while the asset is out on a task.
    const onTask = await this.prisma.reservationAllocation.findFirst({ where: { assetId: c.assetId, releasedAt: null }, select: { reservationId: true } });
    if (onTask) throw new BadRequestException(`Գույքը տրամադրված է առաջադրանքի (ամրագրում #${onTask.reservationId}) — նախ ազատեք հատկացումը`);
    const status = dto.condition === ReleaseCondition.OK ? 'AVAILABLE' : dto.condition === ReleaseCondition.DAMAGED ? 'DAMAGED' : 'RETIRED';
    const released = await this.prisma.$transaction(async (tx) => {
      const row = await tx.assetCustody.update({
        where: { id },
        data: { releasedAt: new Date(), releasedBy: actor.userId, releaseCondition: dto.condition, notes: dto.notes?.trim() ? `${c.notes ? c.notes + '\n' : ''}${dto.notes.trim()}` : c.notes },
        include: custodyInclude,
      });
      await tx.asset.update({ where: { id: c.assetId }, data: { responsibleUserId: null, status } });
      // An asset that came from an object goes back to it (unless it is lost).
      if (c.originObjectId && dto.condition !== ReleaseCondition.LOST) {
        await tx.assetCustody.create({
          data: { assetId: c.assetId, holderType: 'OBJECT', holderObjectId: c.originObjectId, originObjectId: c.originObjectId, via: 'OBJECT_REASSIGN', assignedBy: actor.userId, acceptedAt: new Date() },
        });
      }
      return row;
    });
    void this.announceRelease(c, dto, actor);
    return released;
  }

  /**
   * Phase 2 (2026-10-06): an asset back DAMAGED or LOST reaches issue_assets /
   * manage_warehouse in the item's organisation; a holder whose custody the
   * warehouse closed hears it was taken off them.
   */
  private async announceRelease(c: any, dto: ReturnCustodyDto, actor: Actor) {
    try {
      const what = `${c.asset?.item?.name ?? 'Գույք'}${c.asset?.serialNumber ? ` (${c.asset.serialNumber})` : ''}`;
      const holder = c.holderUserId ? await this.person(c.holderUserId) : null;
      if (dto.condition === ReleaseCondition.DAMAGED || dto.condition === ReleaseCondition.LOST) {
        const category = c.asset?.item?.categoryId
          ? await this.prisma.itemCategory.findUnique({ where: { id: c.asset.item.categoryId }, select: { entityId: true } })
          : null;
        const damaged = dto.condition === ReleaseCondition.DAMAGED;
        await this.notifications.send({
          type: WAREHOUSE_TYPES.assetReturnedDamaged,
          permissions: [PERM.issue, 'manage_warehouse'],
          entityIds: [category?.entityId ?? null],
          actorId: actor.userId,
          title: damaged ? 'Գույքը վերադարձվել է վնասված' : 'Գույքը նշվել է կորած',
          body: `${what}${holder ? ` — ${holder}` : ''}${dto.notes?.trim() ? ` · ${dto.notes.trim()}` : ''}`,
          path: '/assets?tab=custody',
          details: [
            { label: 'Գույք', value: what },
            ...(holder ? [{ label: 'Պատասխանատու', value: holder }] : []),
            { label: 'Վիճակ', value: damaged ? 'Վնասված' : 'Կորած' },
            ...(dto.notes?.trim() ? [{ label: 'Նշում', value: dto.notes.trim() }] : []),
          ],
        });
      }
      if (c.holderUserId && c.holderUserId !== actor.userId) {
        await this.notifications.sendToUsers([c.holderUserId], {
          type: WAREHOUSE_TYPES.responsibilityChanged,
          actorId: actor.userId,
          title: 'Գույքի պատասխանատվությունը հանվել է',
          body: `${what} — պահեստը գրանցել է վերադարձը, դուք այլևս դրա պատասխանատուն չեք։`,
          path: '/profile?tab=assets',
        });
      }
    } catch (e: any) {
      this.logger.warn(`custody release notification failed: ${e?.message ?? e}`);
    }
  }

  /**
   * The register, or one holder's part of it. The warehouse is global (owner
   * decision 2026-10-05): the register is never narrowed to the organisation
   * acted in, and a holder is never looked up in HR's org tree — every
   * organisation's holders, as before 2026-10-02. Somebody else's part, and
   * the whole register, need a custody right; an object's part
   * (holderObjectId) follows GET /custody/object/:objectId's rule.
   */
  async list(
    // itemId (2026-10-08): every unit of one item — the «Ռեսուրսներ» history drawer's «Պատասխանատու» section.
    query: { holderUserId?: number; holderObjectId?: number; open?: boolean; assetId?: number; itemId?: number },
    actor: Actor,
  ) {
    if (query.holderObjectId) {
      await this.assertMayReadObject(query.holderObjectId, actor);
    } else if (query.holderUserId !== actor.userId && !this.has(actor, PERM.view, PERM.issue, PERM.approve)) {
      throw new ForbiddenException('Գույքի պատասխանատվությունները դիտելու իրավունք չկա');
    }
    return this.prisma.assetCustody.findMany({
      where: {
        ...(query.holderUserId ? { holderUserId: query.holderUserId } : {}),
        ...(query.holderObjectId ? { holderObjectId: query.holderObjectId } : {}),
        ...(query.assetId ? { assetId: query.assetId } : {}),
        ...(query.itemId ? { asset: { itemId: query.itemId } } : {}),
        ...(query.open ? { releasedAt: null } : {}),
      },
      include: custodyInclude,
      orderBy: { assignedAt: 'desc' },
    });
  }

  /** What a person still holds — for HR before a deactivation. */
  async openForUser(userId: number) {
    return this.prisma.assetCustody.findMany({
      where: { holderUserId: userId, releasedAt: null },
      include: custodyInclude,
      orderBy: { assignedAt: 'asc' },
    });
  }

  private async notifyUsers(userIds: number[], n: { type: string; actorId?: number | null; title: string; body: string; path: string; details?: { label: string; value: string }[] }) {
    try {
      await this.notifications.sendToUsers(userIds, n);
    } catch (e: any) {
      this.logger.warn(`custody notification failed: ${e?.message ?? e}`);
    }
  }
}
