import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateSupplierDto } from './dto/create-supplier.dto';
import { UpdateSupplierDto } from './dto/update-supplier.dto';

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.supplier.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: number) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id } });
    if (!supplier) throw new NotFoundException('Supplier not found');
    return supplier;
  }

  create(dto: CreateSupplierDto) {
    const { managers, ...rest } = dto;
    return this.prisma.supplier.create({
      data: { ...rest, ...(managers !== undefined && { managers: managers as any }) },
    });
  }

  async update(id: number, dto: UpdateSupplierDto) {
    await this.findOne(id);
    const { managers, ...rest } = dto;
    return this.prisma.supplier.update({
      where: { id },
      data: { ...rest, ...(managers !== undefined && { managers: managers as any }) },
    });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.supplier.delete({ where: { id } });
  }
}
