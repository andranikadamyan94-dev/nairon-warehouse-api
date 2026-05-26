import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { GetItemsQueryDto } from './dto/get-items-query.dto';
import { CategoriesService } from 'src/categories/categories.service';

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoriesService: CategoriesService,
  ) {}

  create(dto: CreateItemDto) {
    return this.prisma.item.create({
      data: dto,
    });
  }

  async findAll(query?: GetItemsQueryDto) {
    let categoryFilter: number[] | undefined;

    if (query?.categoryId) {
      categoryFilter = await this.categoriesService.getDescendantIds(
        Number(query.categoryId),
      );
    }

    return this.prisma.item.findMany({
      where: {
        ...(query?.entityId ? { entityId: query.entityId } : {}),
        ...(categoryFilter ? { categoryId: { in: categoryFilter } } : {}),
        ...(query?.type ? { type: query.type } : {}),
        ...(query?.search
          ? { name: { contains: query.search, mode: 'insensitive' } }
          : {}),
      },

      include: {
        category: true,
        _count: { select: { assets: true } },
      },

      orderBy: {
        id: 'desc',
      },
    });
  }

  async findOne(id: number) {
    const item = await this.prisma.item.findUnique({
      where: { id },
      include: {
        category: true,
        _count: { select: { assets: true } },
      },
    });

    if (!item) {
      throw new NotFoundException({
        message: 'Item not found',
        itemId: id,
      });
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
