import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { GetItemsQueryDto } from './dto/get-items-query.dto';
import { CategoriesService } from 'src/categories/categories.service';
import { StockAlertService } from '../common/notifications/stock-alert.service';

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoriesService: CategoriesService,
    private readonly stockAlerts: StockAlertService,
  ) {}

  async create(dto: CreateItemDto) {
    const item = await this.prisma.item.create({
      data: dto,
    });
    // An item can be created already at or below its threshold.
    this.stockAlerts.check([item.id]);
    return item;
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
        ...(categoryFilter ? { categoryId: { in: categoryFilter } } : {}),
        ...(query?.uncategorized === '1' ? { categoryId: null } : {}),
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

    const item = await this.prisma.item.update({
      where: { id },
      data: dto,
    });
    // Re-evaluate: this edit may have set/raised the threshold or changed the
    // quantity directly, either of which can put the item below the line.
    this.stockAlerts.check([id]);
    return item;
  }

  async remove(id: number) {
    await this.findOne(id);

    return this.prisma.item.delete({
      where: { id },
    });
  }
}
