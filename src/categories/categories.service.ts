import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';

@Injectable()
export class CategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: ResourceWorkspaceService,
  ) {}

  /**
   * Where a new or edited category is filed: what the request names, or the
   * schema default (company 1) when it names nothing.
   *
   * WAREHOUSE V1 CONTRACT: the catalogue is one shared pool, so ItemCategory.
   * entityId is bookkeeping, not a boundary. Who may create or change a
   * category is `manage_categories` on the route — not which companies the
   * actor's roles live in. The head of the warehouse holds a role only in
   * company 6 and files into the pool kept under company 1.
   */
  private workspaceFor(requested?: number | null): number | undefined {
    // undefined leaves the schema default in place on create and leaves the
    // stored value untouched on update; null is not a value this column takes.
    return requested == null ? undefined : Number(requested);
  }

  /**
   * Could this category be filed? The same checks create makes, exposed so the
   * preflight beside it asks exactly this and nothing else.
   */
  async assertMayCreate(actor: WarehouseActor, dto: { entityId?: number; parentId?: number }) {
    this.workspaceFor(dto.entityId);
    if (dto.parentId) await this.assertMayEdit(actor, dto.parentId);
  }

  /**
   * Can this category be changed? It has to exist. Authority is the route's
   * `manage_categories`; the company it is filed under refuses nobody.
   */
  async assertMayEdit(actor: WarehouseActor, id: number) {
    await this.workspaces.of('category', id);
  }

  async create(dto: CreateCategoryDto, actor: WarehouseActor) {
    const entityId = this.workspaceFor(dto.entityId);

    if (dto.parentId) {
      const parent = await this.prisma.itemCategory.findUnique({
        where: {
          id: dto.parentId,
        },
      });

      if (!parent) {
        throw new NotFoundException('Ծնող կատեգորիան չի գտնվել');
      }
      // The parent has to exist; which company it is filed under is bookkeeping.
      await this.assertMayEdit(actor, dto.parentId);
    }

    // One-step "insert a parent above existing trees" (#1943/#2036 follow-up):
    // selected categories are re-parented under the new node atomically.
    const childIds = [...new Set(dto.childIds ?? [])];
    if (childIds.length) {
      const children = await this.prisma.itemCategory.findMany({
        where: { id: { in: childIds } },
        select: { id: true },
      });
      if (children.length !== childIds.length) {
        throw new NotFoundException('Ենթակատեգորիան չի գտնվել');
      }
      if (dto.parentId) {
        if (childIds.includes(dto.parentId)) {
          throw new BadRequestException('Կատեգորիաների շրջանաձև հիերարխիա');
        }
        // a chosen child must not be an ancestor of the chosen parent
        let cur: number | null | undefined = dto.parentId;
        while (cur) {
          if (childIds.includes(cur)) {
            throw new BadRequestException('Կատեգորիաների շրջանաձև հիերարխիա');
          }
          const node = await this.prisma.itemCategory.findUnique({
            where: { id: cur },
            select: { parentId: true },
          });
          cur = node?.parentId;
        }
      }
      const { childIds: _omit, ...data } = dto;
      return this.prisma.$transaction(async (tx) => {
        const created = await tx.itemCategory.create({ data });
        await tx.itemCategory.updateMany({
          where: { id: { in: childIds } },
          data: { parentId: created.id },
        });
        return created;
      });
    }

    const { childIds: _omit, ...data } = dto;
    return this.prisma.itemCategory.create({
      // `data` is remote's dto with childIds stripped; the workspace is
      // local's. A category's workspace is what every item filed under it
      // inherits, so it cannot be dropped here.
      data: { ...(data as any), ...(entityId === undefined ? {} : { entityId }) },
    });
  }

  /**
   * The filter for a list. `?entityId=` narrows the shared catalogue to what is
   * filed under one company when somebody asks for that; nothing narrows it on
   * the actor's behalf. Every authenticated caller reads the whole pool.
   */
  private listScope(entityId?: number) {
    return entityId ? { entityId } : undefined;
  }

  async getAll(entityId?: number, _actor?: WarehouseActor) {
    return this.prisma.itemCategory.findMany({
      where: this.listScope(entityId),
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  async getTree(entityId?: number, _actor?: WarehouseActor) {
    const categories = await this.prisma.itemCategory.findMany({
      where: this.listScope(entityId),
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
      throw new NotFoundException('Կատեգորիան չի գտնվել');
    }

    await this.assertMayEdit(actor, id);
    // Changing entityId refiles the category — and every item under it — in
    // the books. The pool stays one pool; decided the same way a creation is.
    const entityId =
      dto.entityId === undefined ? undefined : this.workspaceFor(dto.entityId);
    if (dto.parentId) await this.assertMayEdit(actor, dto.parentId);

    if (dto.parentId === id) {
      throw new BadRequestException('Կատեգորիան չի կարող լինել ինքն իր ծնողը');
    }

    if (dto.parentId) {
      let currentParentId = dto.parentId;

      while (currentParentId) {
        if (currentParentId === id) {
          throw new BadRequestException('Կատեգորիաների շրջանաձև հիերարխիա');
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
      throw new BadRequestException('Ենթակատեգորիաներ ունեցող կատեգորիան հնարավոր չէ ջնջել');
    }

    const items = await this.prisma.item.count({
      where: {
        categoryId: id,
      },
    });

    if (items > 0) {
      throw new BadRequestException('Ռեսուրսներ ունեցող կատեգորիան հնարավոր չէ ջնջել');
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
