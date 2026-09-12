import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { WarehouseActor, decideCreationWorkspace } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: ResourceWorkspaceService,
  ) {}

  /**
   * Where a new or edited category is filed, decided here rather than taken
   * from the request.
   *
   * ItemCategory.entityId is the one workspace the warehouse actually stores,
   * and until now it was written straight from the body: any caller who could
   * reach this route could file a category into any of the seven companies,
   * including ones they have no role in. A bounded actor is now held to their
   * own; an unbounded one — every caller in this installation today — keeps
   * choosing, which is what the client's category screen expects.
   */
  private workspaceFor(actor: WarehouseActor, requested?: number | null): number | undefined {
    const decided = decideCreationWorkspace(actor, requested);
    if (!decided.ok) {
      throw new ForbiddenException(
        decided.requested === null
          ? 'Name the workspace this category belongs to'
          : 'You hold no role in that workspace',
      );
    }
    // undefined leaves the schema default in place on create and leaves the
    // stored value untouched on update; null is not a value this column takes.
    return decided.workspace ?? undefined;
  }

  /**
   * May this person file a category here? The same decision create makes,
   * exposed so the preflight beside it asks exactly this and nothing else.
   */
  async assertMayCreate(actor: WarehouseActor, dto: { entityId?: number; parentId?: number }) {
    this.workspaceFor(actor, dto.entityId);
    if (dto.parentId) await this.assertMayEdit(actor, dto.parentId);
  }

  /** May this person change this category? It says its own workspace. */
  async assertMayEdit(actor: WarehouseActor, id: number) {
    await this.workspaces.assertMayTouch(actor, 'category', id);
  }

  async create(dto: CreateCategoryDto, actor: WarehouseActor) {
    const entityId = this.workspaceFor(actor, dto.entityId);

    if (dto.parentId) {
      const parent = await this.prisma.itemCategory.findUnique({
        where: {
          id: dto.parentId,
        },
      });

      if (!parent) {
        throw new NotFoundException('Parent category not found');
      }
      // A child under another company's parent would put the tree in two
      // places at once; the parent has to be somewhere this person can reach.
      await this.assertMayEdit(actor, dto.parentId);
    }

    return this.prisma.itemCategory.create({
      data: { ...dto, ...(entityId === undefined ? {} : { entityId }) },
    });
  }

  /**
   * The workspace filter for a list. The query string may narrow the result;
   * for a bounded actor it may not widen it, so their own scope is applied on
   * top of whatever was asked for.
   */
  private listScope(entityId?: number, actor?: WarehouseActor) {
    const mine = actor ? this.workspaces.scopeFor(actor, []) : undefined;
    if (!mine) return entityId ? { entityId } : undefined;
    return entityId ? { AND: [mine, { entityId }] } : mine;
  }

  async getAll(entityId?: number, actor?: WarehouseActor) {
    return this.prisma.itemCategory.findMany({
      where: this.listScope(entityId, actor),
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  async getTree(entityId?: number, actor?: WarehouseActor) {
    const categories = await this.prisma.itemCategory.findMany({
      where: this.listScope(entityId, actor),
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });

    const map = new Map();

    const roots = [];

    for (const category of categories) {
      map.set(category.id, {
        ...category,
        children: [],
      });
    }

    for (const category of categories) {
      const node = map.get(category.id);

      if (category.parentId) {
        const parent = map.get(category.parentId);

        if (parent) {
          parent.children.push(node);
        }
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  async update(id: number, dto: UpdateCategoryDto, actor: WarehouseActor) {
    const existing = await this.prisma.itemCategory.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Category not found');
    }

    await this.assertMayEdit(actor, id);
    // Changing entityId moves the category — and every item filed under it —
    // into another company. Decided the same way a creation is.
    const entityId =
      dto.entityId === undefined ? undefined : this.workspaceFor(actor, dto.entityId);
    if (dto.parentId) await this.assertMayEdit(actor, dto.parentId);

    if (dto.parentId === id) {
      throw new BadRequestException('Category cannot be its own parent');
    }

    if (dto.parentId) {
      let currentParentId = dto.parentId;

      while (currentParentId) {
        if (currentParentId === id) {
          throw new BadRequestException('Circular hierarchy detected');
        }

        const parent = await this.prisma.itemCategory.findUnique({
          where: {
            id: currentParentId,
          },
        });

        currentParentId = parent?.parentId;
      }
    }

    return this.prisma.itemCategory.update({
      where: { id },

      data: { ...dto, ...(entityId === undefined ? {} : { entityId }) },
    });
  }

  async remove(id: number, actor: WarehouseActor) {
    await this.assertMayEdit(actor, id);

    const children = await this.prisma.itemCategory.count({
      where: {
        parentId: id,
      },
    });

    if (children > 0) {
      throw new BadRequestException('Cannot delete category with children');
    }

    const items = await this.prisma.item.count({
      where: {
        categoryId: id,
      },
    });

    if (items > 0) {
      throw new BadRequestException('Cannot delete category with items');
    }

    return this.prisma.itemCategory.delete({
      where: { id },
    });
  }
  async getDescendantIds(categoryId: number) {
    const categories = await this.prisma.itemCategory.findMany();

    const result: number[] = [];

    const walk = (parentId: number) => {
      result.push(parentId);

      const children = categories.filter((x) => x.parentId === parentId);

      for (const child of children) {
        walk(child.id);
      }
    };

    walk(categoryId);

    return result;
  }
}
