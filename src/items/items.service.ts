import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';

@Injectable()
export class ItemsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateItemDto) {
    return this.prisma.item.create({
      data: {
        ...dto,
        quantity: dto.quantity ?? 0,
      },
    });
  }

  async findAll() {
    return this.prisma.item.findMany({
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: number) {
    const item = await this.prisma.item.findUnique({
      where: { id },
    });

    if (!item) {
      throw new NotFoundException('Item not found');
    }

    return item;
  }

  async update(id: number, dto: UpdateItemDto) {
    await this.findOne(id);

    return this.prisma.item.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    return this.prisma.item.delete({
      where: { id },
    });
  }
}
