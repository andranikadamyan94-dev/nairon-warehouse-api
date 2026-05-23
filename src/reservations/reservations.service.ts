import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { AvailabilityService } from '../availability/availability.service';

import { AssetStatus } from '../common/enums/asset-status.enum';
import { ResourceReservationStatus } from '../common/enums/resource-reservation-status.enum';

import { CreateReservationDto } from './dto/create-reservation.dto';
import { AllocateReservationDto } from './dto/allocate-reservation.dto';
import { ReallocateResourceDto } from './dto/reallocate-resource.dto';

@Injectable()
export class ReservationsService {
  constructor(
    private readonly prisma: PrismaService,

    private readonly availabilityService: AvailabilityService,
  ) {}

  async create(dto: CreateReservationDto) {
    const availability = await this.availabilityService.checkAvailability(dto);

    if (!availability.available) {
      throw new BadRequestException(availability);
    }

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    return this.prisma.$transaction(async (tx) => {
      const reservations = [];

      for (const resource of dto.resources) {
        const reservation = await tx.resourceReservation.create({
          data: {
            itemId: resource.itemId,

            quantity: resource.quantity,

            taskId: dto.taskId,

            startDate,
            endDate,

            status: ResourceReservationStatus.APPROVED,
          },
        });

        reservations.push(reservation);
      }

      return reservations;
    });
  }

  async allocate(dto: AllocateReservationDto, allocatedBy?: number) {
    return this.prisma.$transaction(async (tx) => {
      for (const allocation of dto.allocations) {
        const reservation = await tx.resourceReservation.findUnique({
          where: {
            id: allocation.reservationId,
          },
        });

        if (!reservation) {
          throw new NotFoundException('Reservation not found');
        }

        const asset = await tx.asset.findUnique({
          where: {
            id: allocation.assetId,
          },
        });

        if (!asset) {
          throw new NotFoundException('Asset not found');
        }

        if (asset.status !== AssetStatus.AVAILABLE) {
          throw new BadRequestException(`Asset ${asset.id} unavailable`);
        }

        if (asset.itemId !== reservation.itemId) {
          throw new BadRequestException(
            `Asset ${asset.id} does not belong to requested item type`,
          );
        }

        const activeAllocationCount = await tx.reservationAllocation.count({
          where: {
            reservationId: allocation.reservationId,

            releasedAt: null,
          },
        });

        if (activeAllocationCount >= reservation.quantity) {
          throw new BadRequestException('Reservation already fully allocated');
        }

        const overlappingAllocation = await tx.reservationAllocation.findFirst({
          where: {
            assetId: allocation.assetId,

            releasedAt: null,

            reservation: {
              startDate: {
                lte: reservation.endDate,
              },

              endDate: {
                gte: reservation.startDate,
              },
            },
          },
        });

        if (overlappingAllocation) {
          throw new BadRequestException(`Asset ${asset.id} already allocated`);
        }

        const overlappingMaintenance = await tx.maintenanceRecord.findFirst({
          where: {
            assetId: allocation.assetId,

            startDate: {
              lte: reservation.endDate,
            },

            endDate: {
              gte: reservation.startDate,
            },
          },
        });

        if (overlappingMaintenance) {
          throw new BadRequestException(`Asset ${asset.id} under maintenance`);
        }

        await tx.reservationAllocation.create({
          data: {
            reservationId: allocation.reservationId,

            assetId: allocation.assetId,

            allocatedBy,
          },
        });

        await tx.reservationAllocationHistory.create({
          data: {
            reservationId: allocation.reservationId,

            assetId: allocation.assetId,

            action: 'ALLOCATED',

            performedBy: allocatedBy,
          },
        });

        const updatedAllocationCount = await tx.reservationAllocation.count({
          where: {
            reservationId: allocation.reservationId,

            releasedAt: null,
          },
        });

        if (updatedAllocationCount >= reservation.quantity) {
          await tx.resourceReservation.update({
            where: {
              id: reservation.id,
            },

            data: {
              status: ResourceReservationStatus.ALLOCATED,
            },
          });
        } else {
          await tx.resourceReservation.update({
            where: {
              id: reservation.id,
            },

            data: {
              status: ResourceReservationStatus.PARTIALLY_ALLOCATED,
            },
          });
        }
      }

      return {
        success: true,
      };
    });
  }

  async releaseAllocation(
    allocationId: number,
    releasedBy?: number,
    reason?: string,
  ) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: {
        id: allocationId,
      },

      include: {
        reservation: true,
      },
    });

    if (!allocation) {
      throw new NotFoundException('Allocation not found');
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.reservationAllocation.update({
        where: {
          id: allocationId,
        },

        data: {
          releasedAt: new Date(),
        },
      });

      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: allocation.reservationId,

          assetId: allocation.assetId,

          action: 'RELEASED',

          performedBy: releasedBy,

          notes: reason,
        },
      });

      const activeAllocationCount = await tx.reservationAllocation.count({
        where: {
          reservationId: allocation.reservationId,

          releasedAt: null,
        },
      });

      if (activeAllocationCount === 0) {
        await tx.resourceReservation.update({
          where: {
            id: allocation.reservationId,
          },

          data: {
            status: ResourceReservationStatus.APPROVED,
          },
        });
      }

      return {
        success: true,
      };
    });
  }

  async reallocate(dto: ReallocateResourceDto, performedBy?: number) {
    const allocation = await this.prisma.reservationAllocation.findUnique({
      where: {
        id: dto.allocationId,
      },

      include: {
        reservation: true,
      },
    });

    if (!allocation) {
      throw new NotFoundException('Allocation not found');
    }

    const newAsset = await this.prisma.asset.findUnique({
      where: {
        id: dto.newAssetId,
      },
    });

    if (!newAsset) {
      throw new NotFoundException('New asset not found');
    }

    if (newAsset.status !== AssetStatus.AVAILABLE) {
      throw new BadRequestException('Asset unavailable');
    }

    if (newAsset.itemId !== allocation.reservation.itemId) {
      throw new BadRequestException('Asset item type mismatch');
    }

    const overlappingAllocation =
      await this.prisma.reservationAllocation.findFirst({
        where: {
          assetId: dto.newAssetId,

          releasedAt: null,

          reservation: {
            startDate: {
              lte: allocation.reservation.endDate,
            },

            endDate: {
              gte: allocation.reservation.startDate,
            },
          },
        },
      });

    if (overlappingAllocation) {
      throw new BadRequestException('Asset already allocated');
    }

    const overlappingMaintenance =
      await this.prisma.maintenanceRecord.findFirst({
        where: {
          assetId: dto.newAssetId,

          startDate: {
            lte: allocation.reservation.endDate,
          },

          endDate: {
            gte: allocation.reservation.startDate,
          },
        },
      });

    if (overlappingMaintenance) {
      throw new BadRequestException('Asset under maintenance');
    }

    return this.prisma.$transaction(async (tx) => {
      // RELEASE OLD

      await tx.reservationAllocation.update({
        where: {
          id: allocation.id,
        },

        data: {
          releasedAt: new Date(),
        },
      });

      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: allocation.reservationId,

          assetId: allocation.assetId,

          action: 'RELEASED',

          performedBy: performedBy,

          notes: dto.reason,
        },
      });

      // CREATE NEW

      const newAllocation = await tx.reservationAllocation.create({
        data: {
          reservationId: allocation.reservationId,

          assetId: dto.newAssetId,

          allocatedBy: performedBy,
        },
      });

      await tx.reservationAllocationHistory.create({
        data: {
          reservationId: allocation.reservationId,

          assetId: dto.newAssetId,

          action: 'REALLOCATED',

          performedBy: performedBy,

          notes: dto.reason,
        },
      });

      return newAllocation;
    });
  }
}
