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
      include: { item: true },
      orderBy: { createdAt: 'desc' },
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
    endDate?: string;
    reservationId?: number;
  }) {
    const startDate = new Date(query.startDate);
    const endDate = query.endDate ? new Date(query.endDate) : null;

    const ownReservationFilter = query.reservationId
      ? { reservationId: { not: query.reservationId } }
      : {};

    // An active allocation blocks this asset if:
    //   - it is open-ended (endDate = null), OR
    //   - its reservation overlaps the requested window
    const overlapFilter = endDate
      ? {
          OR: [
            { reservation: { endDate: null } },
            { reservation: { startDate: { lte: endDate }, endDate: { gte: startDate } } },
          ],
        }
      : { reservation: { endDate: null } }; // requesting open-ended: only blocked by other open-ended

    const maintenanceFilter = endDate
      ? { startDate: { lte: endDate }, endDate: { gte: startDate } }
      : { startDate: { gte: startDate } }; // open-ended: blocked by any future maintenance

    return this.prisma.asset.findMany({
      where: {
        itemId: query.itemId,
        allocations: {
          none: {
            releasedAt: null,
            ...ownReservationFilter,
            ...overlapFilter,
          },
        },
        maintenanceRecords: {
          none: maintenanceFilter,
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

  getItemHistory(itemId: number) {
    return this.prisma.asset.findMany({
      where: { itemId },
      orderBy: { createdAt: 'asc' },
      include: {
        allocations: {
          include: { reservation: { select: { id: true, taskId: true, projectName: true, startDate: true, endDate: true, notes: true } } },
          orderBy: { allocatedAt: 'asc' },
        },
        maintenanceRecords: { orderBy: { startDate: 'asc' } },
        responsibilities: { orderBy: { id: 'asc' } },
      },
    });
  }
}
