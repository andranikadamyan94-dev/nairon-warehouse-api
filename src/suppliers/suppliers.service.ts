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

  findAll() {
    return this.prisma.supplier.findMany({ include, orderBy: { name: 'asc' } });
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
