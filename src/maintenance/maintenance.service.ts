import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { AssetStatus } from '../common/enums/asset-status.enum';

import { CreateMaintenanceRecordDto } from './dto/create-maintenance-record.dto';

@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  async createRecord(dto: CreateMaintenanceRecordDto) {
    const asset = await this.prisma.asset.findUnique({
      where: {
        id: dto.assetId,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    if (asset.status === AssetStatus.RETIRED) {
      throw new BadRequestException('Cannot maintain retired asset');
    }

    const startDate = new Date(dto.startDate);

    const endDate = new Date(dto.endDate);

    if (startDate >= endDate) {
      throw new BadRequestException('Invalid maintenance dates');
    }

    return this.prisma.$transaction(async (tx) => {
      const overlappingMaintenance = await tx.maintenanceRecord.findFirst({
        where: {
          assetId: dto.assetId,

          startDate: {
            lte: endDate,
          },

          endDate: {
            gte: startDate,
          },
        },
      });

      if (overlappingMaintenance) {
        throw new BadRequestException('Overlapping maintenance exists');
      }

      const record = await tx.maintenanceRecord.create({
        data: {
          assetId: dto.assetId,

          startDate,
          endDate,

          type: dto.type,

          notes: dto.notes,

          createdBy: dto.createdBy,
        },
      });

      return record;
    });
  }

  async getUpcomingMaintenance() {
    const today = new Date();

    return this.prisma.maintenanceRecord.findMany({
      where: {
        endDate: {
          gte: today,
        },
      },

      include: {
        asset: {
          include: {
            item: true,
          },
        },
      },

      orderBy: {
        startDate: 'asc',
      },
    });
  }

  async getAssetMaintenanceHistory(assetId: number) {
    return this.prisma.maintenanceRecord.findMany({
      where: {
        assetId,
      },

      orderBy: {
        startDate: 'desc',
      },
    });
  }
}
