import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { AssignResponsibilityDto } from './dto/assign-responsibility.dto';
import { PrismaService } from 'prisma/prisma.service';
import { WarehouseActor } from '../auth/actor';
import { HolderScope } from '../common/holder-scope.service';
import { decideHoldingsRead } from './holdings-access';

@Injectable()
export class ResponsibilitiesService {
  constructor(
    private readonly prisma: PrismaService,
    // HR's org tree (members/internal) and CRM's object catalogue, over the internal channel.
    private readonly holders: HolderScope,
  ) {}

  async assign(dto: AssignResponsibilityDto) {
    const asset = await this.prisma.asset.findUnique({
      where: {
        id: dto.assetId,
      },
    });

    if (!asset) {
      throw new NotFoundException('Ակտիվը չի գտնվել');
    }

    await this.prisma.assetResponsibility.updateMany({
      where: {
        assetId: dto.assetId,
        releasedAt: null,
      },
      data: {
        releasedAt: new Date(),
      },
    });

    const responsibility = await this.prisma.assetResponsibility.create({
      data: {
        assetId: dto.assetId,
        userId: dto.userId,
        assignedBy: dto.assignedBy,
        notes: dto.notes,
      },
    });

    await this.prisma.asset.update({
      where: {
        id: dto.assetId,
      },
      data: {
        responsibleUserId: dto.userId,
      },
    });

    return responsibility;
  }

  async release(id: number) {
    const r = await this.prisma.assetResponsibility.findUnique({ where: { id } });
    if (!r) throw new NotFoundException('Պատասխանատվության գրառումը չի գտնվել');

    await this.prisma.assetResponsibility.updateMany({
      where: { assetId: r.assetId, releasedAt: null },
      data: { releasedAt: new Date() },
    });

    return this.prisma.asset.update({
      where: { id: r.assetId },
      data: { responsibleUserId: null },
    });
  }

  // Reads come from the custody register (2026-09-23) — the legacy rows were
  // copied there by the migration and new hand-overs only land there. The
  // shape is mapped back to what the responsibilities page renders.
  private fromCustody(c: any) {
    return { id: c.id, assetId: c.assetId, userId: c.holderUserId, assignedAt: c.assignedAt, releasedAt: c.releasedAt, assignedBy: c.assignedBy, notes: c.notes, acceptedAt: c.acceptedAt, holderType: c.holderType, holderObjectId: c.holderObjectId, via: c.via, asset: c.asset };
  }

  async getAssetHistory(assetId: number) {
    const rows = await this.prisma.assetCustody.findMany({ where: { assetId }, orderBy: { assignedAt: 'desc' } });
    return rows.map((c) => this.fromCustody(c));
  }
  /**
   * The register. In an organisation (X-Entity-ID) it holds only that
   * organisation's holders — its members, and objects filed under it (or
   * under none) — unless the caller is a global super-admin. With no
   * organisation declared it is the whole register, as before: nothing in the
   * product reads it without one today (the warehouse client's page reads
   * GET /custody), and the assistant always sends one.
   */
  async getAll(actor?: Pick<WarehouseActor, 'declared' | 'isGlobalSuperAdmin'>) {
    const rows = await this.prisma.assetCustody.findMany({
      include: { asset: { include: { item: true } } },
      orderBy: { assignedAt: 'desc' },
    });
    const scoped =
      actor && actor.declared !== null && !actor.isGlobalSuperAdmin ? await this.holders.filter(rows, actor.declared) : rows;
    return scoped.map((c) => this.fromCustody(c));
  }

  /**
   * holdings-access.ts. No organisation or no right is a 403 (nothing about
   * the person is looked up); a colleague HR does not place in the
   * organisation is a 404; HR unreachable is a 503, never assumed.
   */
  async assertMayReadHoldings(actor: WarehouseActor, userId: number): Promise<void> {
    const verdict = decideHoldingsRead(actor, userId);
    if (verdict.kind === 'refused') {
      throw new ForbiddenException(
        verdict.because === 'no-organisation'
          ? 'Ընտրեք կազմակերպությունը'
          : 'Ուրիշի պատասխանատվությունները տեսնելու թույլտվություն չունեք',
      );
    }
    if (verdict.kind === 'if-member' && !(await this.holders.isMember(verdict.entityId, verdict.userId))) {
      throw new NotFoundException('Աշխատակիցը չի գտնվել');
    }
  }

  async getUserResponsibilities(userId: number) {
    const rows = await this.prisma.assetCustody.findMany({
      where: { holderUserId: userId },
      include: { asset: true },
      orderBy: { assignedAt: 'desc' },
    });
    return rows.map((c) => this.fromCustody(c));
  }
}
