import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

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

    const where: any = {
      ...(categoryFilter ? { categoryId: { in: categoryFilter } } : {}),
      ...(query?.uncategorized === '1' ? { categoryId: null } : {}),
      ...(query?.type ? { type: query.type } : {}),
      ...(query?.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
    };

    // Sub-warehouse workspace (#1989 wave 2): the catalog is global, but a
    // sub's Ապրանքներ page shows ITS holdings — quantity comes from the sub's
    // stock row and the asset count from assets homed there; only items the
    // sub actually holds are listed.
    if (query?.warehouseId && query.warehouseId !== 'main') {
      const whId = Number(query.warehouseId);
      const [stocks, assetCounts] = await Promise.all([
        this.prisma.warehouseStock.findMany({
          where: { warehouseId: whId, quantity: { gt: 0 } },
          select: { itemId: true, quantity: true },
        }),
        this.prisma.asset.groupBy({
          by: ['itemId'],
          where: { warehouseId: whId },
          _count: { id: true },
        }),
      ]);
      const stockOf = new Map(stocks.map((s) => [s.itemId, s.quantity]));
      const assetsOf = new Map(assetCounts.map((a) => [a.itemId, a._count.id]));
      const heldIds = [...new Set([...stockOf.keys(), ...assetsOf.keys()])];
      const rows = await this.prisma.item.findMany({
        where: { ...where, id: { in: heldIds } },
        include: { category: true },
        orderBy: { id: 'desc' },
      });
      return rows.map((r) => ({
        ...r,
        quantity: stockOf.get(r.id) ?? 0,
        _count: { assets: assetsOf.get(r.id) ?? 0 },
      }));
    }

    const rows = await this.prisma.item.findMany({
      where,

      include: {
        category: true,
        _count: { select: { assets: true } },
      },

      orderBy: {
        id: 'desc',
      },
    });

    if (query?.warehouseId !== 'main') return rows;
    // Main workspace: asset counts exclude rows homed in subs.
    const mainCounts = await this.prisma.asset.groupBy({
      by: ['itemId'],
      where: { warehouseId: null, itemId: { in: rows.map((r) => r.id) } },
      _count: { id: true },
    });
    const mainOf = new Map(mainCounts.map((a) => [a.itemId, a._count.id]));
    return rows.map((r) => ({ ...r, _count: { assets: mainOf.get(r.id) ?? 0 } }));
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

    try {
      return await this.prisma.item.delete({
        where: { id },
      });
    } catch (e: any) {
      // RESTRICT on transfer lines is deliberate — surface it as a message,
      // not a 500.
      if (e?.code === 'P2003') {
        throw new BadRequestException(
          'Ապրանքը ունի փոխանցումների պատմություն և չի կարող ջնջվել',
        );
      }
      throw e;
    }
  }
}
