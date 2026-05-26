import { Injectable } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { AssetStatus } from '../common/enums/asset-status.enum';

import { CheckAvailabilityDto } from './dto/check-availability.dto';

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  async checkAvailability(dto: CheckAvailabilityDto) {
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    const unavailableResources = [];

    for (const requestedResource of dto.resources) {
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

      let availableQuantity = 0;

      for (const asset of assets) {
        const overlappingMaintenance = asset.maintenanceRecords.find(
          (maintenance) => {
            return (
              maintenance.startDate <= endDate &&
              maintenance.endDate >= startDate
            );
          },
        );

        if (overlappingMaintenance) {
          continue;
        }

        availableQuantity++;
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
