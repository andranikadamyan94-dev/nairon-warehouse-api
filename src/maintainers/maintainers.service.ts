import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { CreateMaintainerDto } from './dto/create-maintainer.dto';
import { UpdateMaintainerDto } from './dto/update-maintainer.dto';

@Injectable()
export class MaintainersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.maintainer.findMany({ orderBy: { name: 'asc' } });
  }

  async findOne(id: number) {
    const m = await this.prisma.maintainer.findUnique({ where: { id } });
    if (!m) throw new NotFoundException('Maintainer not found');
    return m;
  }

  create(dto: CreateMaintainerDto) {
    return this.prisma.maintainer.create({ data: dto });
  }

  async update(id: number, dto: UpdateMaintainerDto) {
    await this.findOne(id);
    return this.prisma.maintainer.update({ where: { id }, data: dto });
  }

  async remove(id: number) {
    await this.findOne(id);
    return this.prisma.maintainer.delete({ where: { id } });
  }
}
