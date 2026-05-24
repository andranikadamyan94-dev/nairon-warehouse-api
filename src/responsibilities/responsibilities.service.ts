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

  async release(assetId: number) {
    await this.prisma.assetResponsibility.updateMany({
      where: {
        assetId,
        releasedAt: null,
      },
      data: {
        releasedAt: new Date(),
      },
    });

    return this.prisma.asset.update({
      where: {
        id: assetId,
      },
      data: {
        responsibleUserId: null,
      },
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
  async getAll() {
    return this.prisma.assetResponsibility.findMany({
      include: {
        asset: true,
      },

      orderBy: {
        assignedAt: 'desc',
      },
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
