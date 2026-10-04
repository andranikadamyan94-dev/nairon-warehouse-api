import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { AssignResponsibilityDto } from './dto/assign-responsibility.dto';
import { PrismaService } from 'prisma/prisma.service';
import { WarehouseActor } from '../auth/actor';
import { decideHoldingsRead } from './holdings-access';

@Injectable()
export class ResponsibilitiesService {
  constructor(private readonly prisma: PrismaService) {}

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
   * The register — every organisation's holders. The warehouse is global
   * (owner decision 2026-10-05): it is never narrowed to the organisation
   * acted in, and neither HR nor CRM is asked whose holder is whose.
   */
  async getAll() {
    const rows = await this.prisma.assetCustody.findMany({
      include: { asset: { include: { item: true } } },
      orderBy: { assignedAt: 'desc' },
    });
    return rows.map((c) => this.fromCustody(c));
  }

  /**
   * holdings-access.ts: your own always; somebody else's needs a
   * responsibility / custody right, else 403. Nothing about the person is
   * looked up — the warehouse is global.
   */
  assertMayReadHoldings(actor: WarehouseActor, userId: number): void {
    if (decideHoldingsRead(actor, userId).kind === 'refused') {
      throw new ForbiddenException('Ուրիշի պատասխանատվությունները տեսնելու թույլտվություն չունեք');
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
