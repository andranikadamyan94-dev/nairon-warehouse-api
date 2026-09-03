import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCategoryDto) {
    if (dto.parentId) {
      const parent = await this.prisma.itemCategory.findUnique({
        where: {
          id: dto.parentId,
        },
      });

      if (!parent) {
        throw new NotFoundException('Parent category not found');
      }
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
        throw new NotFoundException('Child category not found');
      }
      if (dto.parentId) {
        if (childIds.includes(dto.parentId)) {
          throw new BadRequestException('Circular hierarchy detected');
        }
        // a chosen child must not be an ancestor of the chosen parent
        let cur: number | null | undefined = dto.parentId;
        while (cur) {
          if (childIds.includes(cur)) {
            throw new BadRequestException('Circular hierarchy detected');
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
      data: data as any,
    });
  }

  async getAll(entityId?: number) {
    return this.prisma.itemCategory.findMany({
      where: entityId ? { entityId } : undefined,
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
    });
  }

  async getTree(entityId?: number) {
    const categories = await this.prisma.itemCategory.findMany({
      where: entityId ? { entityId } : undefined,
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

  async update(id: number, dto: UpdateCategoryDto) {
    const existing = await this.prisma.itemCategory.findUnique({
      where: { id },
    });

    if (!existing) {
      throw new NotFoundException('Category not found');
    }

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

      data: dto,
    });
  }

  async remove(id: number) {
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
