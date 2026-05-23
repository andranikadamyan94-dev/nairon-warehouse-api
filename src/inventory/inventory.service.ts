import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from 'prisma/prisma.service';

import { ItemType } from '../common/enums/item-type.enum';

import {
  InventoryMovementDto,
  InventoryMovementType,
} from './dto/inventory-movement.dto';

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async createMovement(dto: InventoryMovementDto) {
    const item = await this.prisma.item.findUnique({
      where: {
        id: dto.itemId,
      },
    });

    if (!item) {
      throw new NotFoundException('Item not found');
    }

    if (item.type !== ItemType.CONSUMABLE) {
      throw new BadRequestException(
        'Inventory movements only supported for consumables',
      );
    }

    let newQuantity = item.quantity;

    switch (dto.type) {
      case InventoryMovementType.IN:
        newQuantity += dto.quantity;
        break;

      case InventoryMovementType.OUT:
      case InventoryMovementType.RESERVATION:
        newQuantity -= dto.quantity;
        break;

      case InventoryMovementType.RELEASE:
        newQuantity += dto.quantity;
        break;

      case InventoryMovementType.ADJUSTMENT:
        newQuantity = dto.quantity;
        break;
    }

    if (newQuantity < 0) {
      throw new BadRequestException('Insufficient inventory quantity');
    }

    return this.prisma.$transaction(async (tx) => {
      const movement = await tx.inventoryMovement.create({
        data: dto,
      });

      await tx.item.update({
        where: {
          id: item.id,
        },
        data: {
          quantity: newQuantity,
        },
      });

      return movement;
    });
  }

  async getMovements(itemId?: number) {
    return this.prisma.inventoryMovement.findMany({
      where: itemId
        ? {
            itemId,
          }
        : undefined,
      include: {
        item: true,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }
}
