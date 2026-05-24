import { Injectable } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

@Injectable()
export class AllocationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAll(query: any) {
    const page = Number(query.page ?? 1);

    const limit = Number(query.limit ?? 10);

    const [data, total] = await Promise.all([
      this.prisma.reservationAllocation.findMany({
        skip: (page - 1) * limit,

        take: limit,

        include: {
          asset: {
            include: {
              item: true,
            },
          },

          reservation: {
            include: {
              item: true,
            },
          },
        },
      }),

      this.prisma.reservationAllocation.count(),
    ]);

    return {
      data,
      total,
      page,
      limit,
    };
  }

  async getOne(id: number) {
    return this.prisma.reservationAllocation.findUnique({
      where: {
        id,
      },

      include: {
        asset: {
          include: {
            item: true,
          },
        },

        reservation: {
          include: {
            item: true,
          },
        },
      },
    });
  }

  async remove(id: number) {
    return this.prisma.reservationAllocation.delete({
      where: {
        id,
      },
    });
  }
}
