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
    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);

    await this.prisma.$transaction(async (tx) => {
      for (const resource of dto.resources) {
        await tx.resourceReservation.create({
          data: {
            itemId: resource.itemId,
            quantity: resource.quantity,
            taskId: dto.taskId,
            startDate,
            endDate,
            status: availability.unavailableResources?.some(
              (item) => item.itemId === resource.itemId,
            )
              ? ResourceReservationStatus.PENDING
              : ResourceReservationStatus.APPROVED,
          },
        });
      }
    });

    if (availability.unavailableResources.length) {
      console.log('WAREHOUSE_ADMIN_NOTIFICATION', {
        taskId: dto.taskId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        unavailableResources: availability.unavailableResources,
      });
    }

    return {
      available: availability.unavailableResources.length === 0,
      unavailableResources: availability.unavailableResources,
    };
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
  async getAll(query: any) {
    const page = Number(query.page ?? 1);

    const limit = Number(query.limit ?? 10);

    const [data, total] = await Promise.all([
      this.prisma.resourceReservation.findMany({
        skip: (page - 1) * limit,

        take: limit,

        include: {
          item: true,

          allocations: {
            where: { releasedAt: null },
            include: {
              asset: true,
            },
          },

          allocationHistory: {
            include: { asset: true },
            orderBy: { performedAt: 'asc' },
          },
        },

        orderBy: {
          createdAt: 'desc',
        },
      }),

      this.prisma.resourceReservation.count(),
    ]);

    const enriched = await Promise.all(
      data.map(async (reservation) => {
        const otherReserved = await this.prisma.resourceReservation.aggregate({
          where: {
            itemId: reservation.itemId,
            taskId: { not: reservation.taskId },
            startDate: { lte: reservation.endDate },
            endDate: { gte: reservation.startDate },
          },
          _sum: { quantity: true },
        });
        const totalQuantity = reservation.item?.quantity ?? 0;
        const reserved = otherReserved._sum.quantity ?? 0;
        const freeQuantity = Math.max(0, totalQuantity - reserved);
        return { ...reservation, freeQuantity };
      }),
    );

    return {
      data: enriched,
      total,
      page,
      limit,
    };
  }

  async getOne(id: number) {
    return this.prisma.resourceReservation.findUnique({
      where: {
        id,
      },

      include: {
        item: true,

        allocations: {
          include: {
            asset: true,
          },
        },
      },
    });
  }

  async updateTaskReservations(taskId: number, dto: CreateReservationDto) {
    const availability = await this.availabilityService.checkAvailability({
      ...dto,
      excludeTaskId: taskId,
    });
    const startDate = new Date(dto.startDate);

    const endDate = new Date(dto.endDate);

    return this.prisma.$transaction(async (tx) => {
      const existingReservations = await tx.resourceReservation.findMany({
        where: {
          taskId,
        },
      });

      const incomingItemIds = dto.resources.map((x) => x.itemId);

      for (const existing of existingReservations) {
        if (!incomingItemIds.includes(existing.itemId)) {
          await tx.resourceReservation.delete({
            where: {
              id: existing.id,
            },
          });
        }
      }

      for (const resource of dto.resources) {
        const existing = existingReservations.find(
          (x) => x.itemId === resource.itemId,
        );

        const unavailable = availability.unavailableResources?.some(
          (x) => x.itemId === resource.itemId,
        );

        if (existing) {
          await tx.resourceReservation.update({
            where: {
              id: existing.id,
            },

            data: {
              quantity: resource.quantity,

              startDate,

              endDate,

              status: unavailable
                ? ResourceReservationStatus.PENDING
                : ResourceReservationStatus.APPROVED,
            },
          });
        } else {
          await tx.resourceReservation.create({
            data: {
              taskId,

              itemId: resource.itemId,

              quantity: resource.quantity,

              startDate,

              endDate,

              status: unavailable
                ? ResourceReservationStatus.PENDING
                : ResourceReservationStatus.APPROVED,
            },
          });
        }
      }

      return {
        available: availability.unavailableResources.length === 0,

        unavailableResources: availability.unavailableResources,
      };
    });
  }

  async getTaskReservations(taskId: number) {
    const reservations = await this.prisma.resourceReservation.findMany({
      where: {
        taskId,
      },

      include: {
        item: true,
      },

      orderBy: {
        id: 'asc',
      },
    });

    return reservations.map((reservation) => ({
      itemId: reservation.itemId,

      itemName: reservation.item.name,

      requestedQuantity: reservation.quantity,

      available: reservation.status !== ResourceReservationStatus.PENDING,

      startDate: reservation.startDate,

      endDate: reservation.endDate,
    }));
  }
}
