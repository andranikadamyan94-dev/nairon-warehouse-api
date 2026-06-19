import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

const include = {
  supplierItems: { include: { item: true } },
};

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(query?: { search?: string; itemIds?: string; page?: string; limit?: string; sortBy?: string; sortOrder?: string }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);
    const search = query?.search;
    const order: 'asc' | 'desc' = query?.sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: any =
      query?.sortBy === 'createdAt' ? { createdAt: order } : { name: query?.sortBy === 'name' ? order : 'asc' };

    const itemIds = query?.itemIds
      ? String(query.itemIds).split(',').map(Number).filter(Boolean)
      : [];

    const where: any = {};

    if (search) {
      const rows = await this.prisma.$queryRaw<{ id: number }[]>`
        SELECT id FROM "Supplier"
        WHERE name ILIKE ${`%${search}%`}
           OR phone ILIKE ${`%${search}%`}
           OR email ILIKE ${`%${search}%`}
           OR "registryNumber" ILIKE ${`%${search}%`}
           OR managers::text ILIKE ${`%${search}%`}
      `;
      where.id = { in: rows.map((r) => r.id) };
    }

    if (itemIds.length) {
      where.supplierItems = { some: { itemId: { in: itemIds } } };
    }

    const [data, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        include,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id }, include });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  create(dto: CreateSupplierDto) {
    const { managers, items, ...rest } = dto;
    return this.prisma.supplier.create({
      data: {
        ...rest,
        ...(managers !== undefined && { managers: managers as any }),
        ...(items?.length && {
          supplierItems: {
            create: items.map((i) => ({ itemId: i.itemId, unitPrice: i.unitPrice })),
          },
        }),
      },
      include,
    });
  }

  async update(id: number, dto: UpdateSupplierDto) {
    await this.findOne(id);
    const { managers, items, ...rest } = dto;

    return this.prisma.$transaction(async (tx) => {
      if (items !== undefined) {
        await tx.supplierItem.deleteMany({ where: { supplierId: id } });
        if (items.length) {
          await tx.supplierItem.createMany({
            data: items.map((i) => ({ supplierId: id, itemId: i.itemId, unitPrice: i.unitPrice })),
          });
        }
      }

      return tx.supplier.update({
        where: { id },
        data: { ...rest, ...(managers !== undefined && { managers: managers as any }) },
        include,
      });
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.supplier.delete({ where: { id } });
  }
}
