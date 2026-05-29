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
  async getAll(query: any) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);
    const [data, total] = await Promise.all([
      this.prisma.maintenanceRecord.findMany({
        skip: (page - 1) * limit,
        take: limit,
        include: { asset: { include: { item: true } } },
        orderBy: { startDate: 'desc' },
      }),
      this.prisma.maintenanceRecord.count(),
    ]);

    return {
      data,
      total,
      page,
      limit,
    };
  }

  async getOne(id: number) {
    return this.prisma.maintenanceRecord.findUnique({
      where: {
        id,
      },

      include: {
        asset: {
          include: {
            item: true,
          },
        },
      },
    });
  }

  async update(id: number, dto: Partial<CreateMaintenanceRecordDto>) {
    const record = await this.prisma.maintenanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Maintenance record not found');

    const startDate = dto.startDate ? new Date(dto.startDate) : record.startDate;
    const endDate = dto.endDate ? new Date(dto.endDate) : record.endDate;

    if (startDate >= endDate) throw new BadRequestException('Invalid maintenance dates');

    return this.prisma.maintenanceRecord.update({
      where: { id },
      data: {
        startDate,
        endDate,
        type: dto.type ?? record.type,
        notes: dto.notes !== undefined ? dto.notes : record.notes,
      },
    });
  }

  async remove(id: number) {
    const record = await this.prisma.maintenanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Maintenance record not found');
    return this.prisma.maintenanceRecord.delete({ where: { id } });
  }
}
