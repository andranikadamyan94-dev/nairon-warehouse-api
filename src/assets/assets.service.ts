import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';

@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  create(dto: CreateAssetDto) {
    return this.prisma.asset.create({
      data: dto,
    });
  }

  findAll() {
    return this.prisma.asset.findMany({
      include: {
        item: true,
      },

      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: number) {
    const asset = await this.prisma.asset.findUnique({
      where: { id },

      include: {
        item: true,
        maintenanceRecords: true,
        responsibilities: true,
        allocations: true,
      },
    });

    if (!asset) {
      throw new NotFoundException({
        message: 'Asset not found',
        assetId: id,
      });
    }

    return asset;
  }

  async update(id: number, dto: UpdateAssetDto) {
    await this.findOne(id);

    return this.prisma.asset.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    return this.prisma.asset.delete({
      where: { id },
    });
  }

  async getAvailableAssets(query: {
    itemId: number;
    startDate: string;
    endDate: string;
  }) {
    const startDate = new Date(query.startDate);

    const endDate = new Date(query.endDate);

    return this.prisma.asset.findMany({
      where: {
        itemId: query.itemId,

        allocations: {
          none: {
            reservation: {
              startDate: {
                lte: endDate,
              },

              endDate: {
                gte: startDate,
              },
            },
          },
        },
      },

      include: {
        item: true,
      },
    });
  }

  async getAssetHistory(assetId: number) {
    return this.prisma.asset.findUnique({
      where: {
        id: assetId,
      },

      include: {
        allocations: {
          include: {
            reservation: true,
          },
        },

        maintenanceRecords: true,

        responsibilities: true,
      },
    });
  }
}
