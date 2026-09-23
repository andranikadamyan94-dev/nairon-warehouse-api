import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { UsersPrismaService } from '../common/users-prisma.service';
import { WarehouseNotificationsService } from '../common/notifications/notifications.service';
import { CreateAssetRequestDto, DirectIssueDto, IssueAssetRequestDto, ObjectIssueDto, ReassignCustodyDto, ReleaseCondition, ReturnCustodyDto } from './dto/asset-custody.dto';
import { ObjectsService } from '../objects/objects.service';

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

  async createRequest(dto: CreateAssetRequestDto, actor: Actor, entityId: number | null) {
    const forObject = dto.forObjectId ? await this.objects.crmObject(dto.forObjectId) : null;
    if (dto.forObjectId && !forObject) throw new NotFoundException('Օբյեկտը չի գտնվել');
    const forUserId: number | null = forObject ? null : dto.forUserId ?? actor.userId;
    // Asking for yourself needs the request permission; asking on someone
    // else's behalf (HR at onboarding, a head) needs approve or issue rights.
    if (forUserId && forUserId !== actor.userId && !this.has(actor, PERM.approve, PERM.issue)) {
      throw new ForbiddenException('Ուրիշի համար հայտ ներկայացնելու իրավունք չկա');
    }
    const item = await this.prisma.item.findUnique({ where: { id: dto.itemId } });
    if (!item) throw new NotFoundException('Ռեսուրսը չի գտնվել');
    if (item.type !== 'ASSET') throw new BadRequestException('Հայտ կարելի է ներկայացնել միայն ակտիվների համար');
    if (forUserId && (await this.usersPrisma.isDeactivated(forUserId))) throw new BadRequestException('Աշխատակիցն ապաակտիվացված է');

    const request = await this.prisma.assetRequest.create({
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
    const who = forObject ? `${forObject.code} ${forObject.name}` : await this.person(forUserId!);
    void this.notifications.send({
      permissions: [PERM.approve],
      title: 'Նոր գույքի հայտ',
      body: `${who}՝ ${item.name} × ${request.quantity}${request.reason ? ` — ${request.reason}` : ''}`,
      path: '/responsibilities?tab=requests',
      details: [{ label: 'Հայտ', value: `#${request.id}` }],
    });
    return request;
  }

  async listRequests(query: { status?: string; forUserId?: number; mine?: boolean }, actor: Actor) {
    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.forUserId) where.forUserId = query.forUserId;
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
      title: approve ? 'Գույքի հայտը հաստատվեց' : 'Գույքի հայտը մերժվեց',
      body: `${r.item.name} × ${r.quantity}${note ? ` — ${note}` : ''}`,
      path: '/profile?tab=assets',
    });
    if (approve) {
      void this.notifications.send({
        permissions: [PERM.issue],
        title: 'Հաստատված գույքի հայտ՝ տրամադրման',
        body: `${r.forObjectId ? `Օբյեկտ #${r.forObjectId}` : await this.person(r.forUserId ?? r.requestedBy)}՝ ${r.item.name} × ${r.quantity}`,
        path: '/responsibilities?tab=requests',
        details: [{ label: 'Հայտ', value: `#${r.id}` }],
      });
    }
    return updated;
  }

  async cancel(id: number, actor: Actor) {
    const r = await this.requestOr404(id);
    if (r.requestedBy !== actor.userId && !actor.isSuperAdmin) throw new ForbiddenException();
    if (!['PENDING', 'APPROVED'].includes(r.status)) throw new BadRequestException('Հայտն այլևս հնարավոր չէ չեղարկել');
    return this.prisma.assetRequest.update({ where: { id }, data: { status: 'CANCELLED' } });
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
          // Objects cannot click "received": the hand-over is the acceptance.
          acceptedAt: new Date(),
          notes: opts.notes?.trim() || null,
        },
        include: custodyInclude,
      });
      await tx.asset.update({ where: { id: assetId }, data: { responsibleUserId: null } });
      return row;
    });
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
      title: 'Ձեզ գույք է տրամադրվել',
      body: `${row.asset.item.name}${row.asset.serialNumber ? ` (${row.asset.serialNumber})` : ''} — ${object ? `${object.code} ${object.name}` : 'օբյեկտ'} · հաստատեք ստացումը`,
      path: '/profile?tab=assets',
    });
    return row;
  }

  /** What an object holds, and held. Objects are visible to every signed-in CRM user, so is this. */
  async forObject(objectId: number) {
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
    if (c.holderUserId !== actor.userId) throw new ForbiddenException('Ստացումը հաստատում է միայն ստացողը');
    if (c.releasedAt) throw new BadRequestException('Գույքն արդեն վերադարձված է');
    if (c.acceptedAt) return c;
    return this.prisma.assetCustody.update({ where: { id }, data: { acceptedAt: new Date() }, include: custodyInclude });
  }

  async release(id: number, dto: ReturnCustodyDto, actor: Actor) {
    const c = await this.prisma.assetCustody.findUnique({ where: { id }, include: custodyInclude });
    if (!c) throw new NotFoundException('Գրառումը չի գտնվել');
    if (c.releasedAt) throw new BadRequestException('Գույքն արդեն վերադարձված է');
    if (c.holderUserId !== actor.userId && !this.has(actor, PERM.issue)) {
      throw new ForbiddenException('Վերադարձը գրանցում է ստացողը կամ պահեստը');
    }
    if (c.holderType === 'OBJECT') throw new BadRequestException('Օբյեկտին տրված գույքը պահեստ չի վերադառնում');
    const status = dto.condition === ReleaseCondition.OK ? 'AVAILABLE' : dto.condition === ReleaseCondition.DAMAGED ? 'DAMAGED' : 'RETIRED';
    return this.prisma.$transaction(async (tx) => {
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
  }

  async list(query: { holderUserId?: number; holderObjectId?: number; open?: boolean; assetId?: number }, actor: Actor) {
    if (query.holderUserId !== actor.userId && !query.holderObjectId && !this.has(actor, PERM.view, PERM.issue, PERM.approve)) {
      throw new ForbiddenException('Գույքի պատասխանատվությունները դիտելու իրավունք չկա');
    }
    return this.prisma.assetCustody.findMany({
      where: {
        ...(query.holderUserId ? { holderUserId: query.holderUserId } : {}),
        ...(query.holderObjectId ? { holderObjectId: query.holderObjectId } : {}),
        ...(query.assetId ? { assetId: query.assetId } : {}),
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

  private async notifyUsers(userIds: number[], n: { title: string; body: string; path: string }) {
    try {
      await this.notifications.sendToUsers(userIds, n);
    } catch (e: any) {
      this.logger.warn(`custody notification failed: ${e?.message ?? e}`);
    }
  }
}
