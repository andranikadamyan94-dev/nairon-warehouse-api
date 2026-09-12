import { Injectable, NotFoundException } from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateItemDto } from './dto/create-item.dto';
import { UpdateItemDto } from './dto/update-item.dto';
import { GetItemsQueryDto } from './dto/get-items-query.dto';
import { CategoriesService } from 'src/categories/categories.service';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';

@Injectable()
export class ItemsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categoriesService: CategoriesService,
    private readonly stockAlerts: StockAlertService,
    private readonly workspaces: ResourceWorkspaceService,
  ) {}

  /**
   * May this person put an item in this part of the catalogue?
   *
   * An item's workspace is its category's, so filing it is the moment its
   * workspace is decided — and the only moment worth checking, since an item
   * with no category has no workspace at all. A bounded actor cannot create
   * one, because there would be nowhere for it to be.
   *
   * Called by create, by update when the category moves, and by the preflight
   * beside both, so the question is asked once and answered the same way.
   */
  async assertMayFileUnder(actor: WarehouseActor, categoryId?: number | null) {
    const workspace =
      categoryId == null ? null : (await this.workspaces.ofCategory(categoryId)).workspace;
    this.workspaces.assertMayTouchWorkspace(actor, 'item', workspace);
  }

  /** May this person change this item? Its workspace is its category's. */
  async assertMayEdit(actor: WarehouseActor, id: number) {
    await this.workspaces.assertMayTouch(actor, 'item', id);
  }

  async create(dto: CreateItemDto, actor: WarehouseActor) {
    await this.assertMayFileUnder(actor, dto.categoryId);

    const item = await this.prisma.item.create({
      data: dto,
    });
    // An item can be created already at or below its threshold.
    this.stockAlerts.check([item.id]);
    return item;
  }

  async findAll(query?: GetItemsQueryDto, actor?: WarehouseActor) {
    let categoryFilter: number[] | undefined;

    if (query?.categoryId) {
      categoryFilter = await this.categoriesService.getDescendantIds(
        Number(query.categoryId),
      );
    }

    // Narrowed only for an actor who is bounded — a workspace they declared, or
    // roles that live in particular companies. Everyone in this installation
    // holds a wildcard role and declares nothing, so today this adds no filter
    // and the list is the list it always was. That is deliberate: the CRM task
    // screen reads this route with no warehouse permission at all.
    const scope = actor ? this.workspaces.scopeFor(actor, ['category']) : undefined;

    return this.prisma.item.findMany({
      where: {
        ...(scope ?? {}),
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

  async findOne(id: number, actor?: WarehouseActor) {
    // Out of scope reads as missing rather than as forbidden: a bounded actor
    // learns nothing about another company's catalogue, not even that a given
    // id is taken.
    const scope = actor ? this.workspaces.scopeFor(actor, ['category']) : undefined;
    const item = await this.prisma.item.findFirst({
      where: { id, ...(scope ?? {}) },
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

  async update(id: number, dto: UpdateItemDto, actor: WarehouseActor) {
    await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);
    // Moving an item into another company's catalogue moves the item itself.
    // The destination has to be somewhere this person could have created it.
    if (dto.categoryId !== undefined) await this.assertMayFileUnder(actor, dto.categoryId);

    const item = await this.prisma.item.update({
      where: { id },
      data: dto,
    });
    // Re-evaluate: this edit may have set/raised the threshold or changed the
    // quantity directly, either of which can put the item below the line.
    this.stockAlerts.check([id]);
    return item;
  }

  async remove(id: number, actor: WarehouseActor) {
    await this.findOne(id, actor);
    await this.assertMayEdit(actor, id);

    return this.prisma.item.delete({
      where: { id },
    });
  }
}
