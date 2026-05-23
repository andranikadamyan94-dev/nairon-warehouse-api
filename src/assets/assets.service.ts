import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { ItemType } from '../common/enums/item-type.enum';

import { CreateAssetDto } from './dto/create-asset.dto';
import { UpdateAssetDto } from './dto/update-asset.dto';

@Injectable()
export class AssetsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateAssetDto) {
    const item = await this.prisma.item.findUnique({
      where: {
        id: dto.itemId,
      },
    });

    if (!item) {
      throw new NotFoundException('Item not found');
    }

    if (item.type !== ItemType.ASSET) {
      throw new BadRequestException('Item is not an asset type');
    }

    return this.prisma.asset.create({
      data: dto,
    });
  }

  async findAll() {
    return this.prisma.asset.findMany({
      include: {
        item: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async findOne(id: number) {
    const asset = await this.prisma.asset.findUnique({
      where: { id },
      include: {
        item: true,
      },
    });

    if (!asset) {
      throw new NotFoundException('Asset not found');
    }

    return asset;
  }

  async update(id: number, dto: UpdateAssetDto) {
    await this.findOne(id);

    return this.prisma.asset.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: number) {
    await this.findOne(id);

    return this.prisma.asset.delete({
      where: { id },
    });
  }
}
