import { Injectable } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { AssetStatus } from '../common/enums/asset-status.enum';
import { ItemType } from '../common/enums/item-type.enum';

import { CheckAvailabilityDto } from './dto/check-availability.dto';

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async checkAvailability(dto: CheckAvailabilityDto) {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    const unavailableResources = [];

    for (const requestedResource of dto.resources) {
      const item = await this.prisma.item.findUnique({
        where: { id: requestedResource.itemId },
      });

      const assets = await this.prisma.asset.findMany({
        where: {
          itemId: requestedResource.itemId,

          status: {
            notIn: [AssetStatus.DAMAGED, AssetStatus.RETIRED],
          },
        },

        include: {
          maintenanceRecords: true,
        },
      });

      // Start from item.quantity as total stock
      let availableQuantity = item?.quantity ?? 0;

      // Subtract assets that are under maintenance in the requested date range
      if (assets.length > 0) {
        const underMaintenance = assets.filter((asset) =>
          asset.maintenanceRecords.some(
            (m) => m.startDate <= endDate && m.endDate >= startDate,
          ),
        ).length;

        availableQuantity = Math.max(0, availableQuantity - underMaintenance);
      }

      const overlappingReservations =
        await this.prisma.resourceReservation.aggregate({
          where: {
            itemId: requestedResource.itemId,

            startDate: {
              lte: endDate,
            },

            endDate: {
              gte: startDate,
            },

            ...(dto.excludeTaskId
              ? {
                  taskId: {
                    not: dto.excludeTaskId,
                  },
                }
              : {}),
          },

          _sum: {
            quantity: true,
          },
        });

      const reservedQuantity = overlappingReservations._sum.quantity ?? 0;

      availableQuantity = Math.max(0, availableQuantity - reservedQuantity);

      if (availableQuantity < requestedResource.quantity) {
        unavailableResources.push({
          itemId: requestedResource.itemId,

          available: availableQuantity,

          requested: requestedResource.quantity,
        });
      }
    }

    return {
      available: unavailableResources.length === 0,

      unavailableResources,
    };
  }
}
