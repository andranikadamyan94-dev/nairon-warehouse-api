import { Injectable, NotFoundException } from '@nestjs/common';

import { AssignResponsibilityDto } from './dto/assign-responsibility.dto';
import { PrismaService } from 'prisma/prisma.service';

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
      throw new NotFoundException('Asset not found');
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
    if (!r) throw new NotFoundException('Responsibility not found');

    await this.prisma.assetResponsibility.updateMany({
      where: { assetId: r.assetId, releasedAt: null },
      data: { releasedAt: new Date() },
    });

    return this.prisma.asset.update({
      where: { id: r.assetId },
      data: { responsibleUserId: null },
    });
  }

  async getAssetHistory(assetId: number) {
    return this.prisma.assetResponsibility.findMany({
      where: {
        assetId,
      },
      orderBy: {
        assignedAt: 'desc',
      },
    });
  }
  async getAll(entityId?: number) {
    return this.prisma.assetResponsibility.findMany({
      where: entityId ? { asset: { item: { entityId } } } : undefined,
      include: { asset: { include: { item: true } } },
      orderBy: { assignedAt: 'desc' },
    });
  }

  async getUserResponsibilities(userId: number) {
    return this.prisma.assetResponsibility.findMany({
      where: {
        userId,
      },

      include: {
        asset: true,
      },

      orderBy: {
        assignedAt: 'desc',
      },
    });
  }
}
