import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { AssetStatus } from '../common/enums/asset-status.enum';
import { CreateMaintenanceRecordDto } from './dto/create-maintenance-record.dto';

const include = {
  asset: { include: { item: true } },
  maintainer: true,
};

@Injectable()
export class MaintenanceService {
  constructor(private readonly prisma: PrismaService) {}

  async createRecord(dto: CreateMaintenanceRecordDto) {
    const asset = await this.prisma.asset.findUnique({ where: { id: dto.assetId } });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.status === AssetStatus.RETIRED) throw new BadRequestException('Cannot maintain retired asset');

    return this.prisma.maintenanceRecord.create({
      data: {
        assetId: dto.assetId,
        maintainerId: dto.maintainerId ?? null,
        amount: dto.amount ?? null,
        startDate: new Date(dto.startDate),
        endDate: dto.endDate ? new Date(dto.endDate) : null,
        type: dto.type,
        notes: dto.notes,
        createdBy: dto.createdBy,
      },
      include,
    });
  }

  async finalize(id: number, amount: number) {
    const record = await this.prisma.maintenanceRecord.findUnique({ where: { id }, include });
    if (!record) throw new NotFoundException('Maintenance record not found');
    if (record.status !== 'DRAFT') throw new BadRequestException('Only DRAFT records can be submitted for finance approval');
    if (!amount || amount <= 0) throw new BadRequestException('Amount is required to request finance approval');

    const financeUrl = process.env.FINANCE_API_URL || 'http://localhost:3005';
    let financeTransferId: number | undefined;
    try {
      const res = await fetch(`${financeUrl}/api/transfer/external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': process.env.INTERNAL_SECRET || '' },
        body: JSON.stringify({
          amount,
          description: `Maintenance #${id}${record.maintainer ? ` — ${record.maintainer.name}` : ''}`,
          externalRef: `warehouse_maintenance:${id}`,
          date: new Date().toISOString(),
          entityId: (record.asset as any).entityId ?? undefined,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { id: number };
        financeTransferId = data.id;
      }
    } catch {}

    return this.prisma.maintenanceRecord.update({
      where: { id },
      data: {
        amount,
        status: 'PENDING_FINANCE',
        ...(financeTransferId ? { financeTransferId } : {}),
      },
      include,
    });
  }

  async financeCallback(id: number, status: 'APPROVED' | 'REJECTED') {
    const record = await this.prisma.maintenanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Maintenance record not found');
    if (record.status !== 'PENDING_FINANCE') throw new BadRequestException('Record is not pending finance approval');

    return this.prisma.maintenanceRecord.update({
      where: { id },
      data: { status: status === 'APPROVED' ? 'FINANCE_APPROVED' : 'FINANCE_REJECTED' },
      include,
    });
  }

  async complete(id: number) {
    const record = await this.prisma.maintenanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Maintenance record not found');
    if (record.status === 'COMPLETED') throw new BadRequestException('Maintenance is already completed');
    if (record.status === 'DRAFT') throw new BadRequestException('Cannot complete a draft record');

    return this.prisma.maintenanceRecord.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        endDate: new Date(),
      },
      include,
    });
  }

  async getUpcomingMaintenance() {
    return this.prisma.maintenanceRecord.findMany({
      where: { endDate: { gte: new Date() } },
      include,
      orderBy: { startDate: 'asc' },
    });
  }

  async getAssetMaintenanceHistory(assetId: number) {
    return this.prisma.maintenanceRecord.findMany({
      where: { assetId },
      include,
      orderBy: { startDate: 'desc' },
    });
  }

  async getAll(query: any) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);
    const search = query.search as string | undefined;

    const entityId = query.entityId ? Number(query.entityId) : undefined;
    const where: any = {
      ...(entityId ? { asset: { entityId } } : {}),
      ...(search ? {
        OR: [
          { asset: { serialNumber: { contains: search, mode: 'insensitive' } } },
          { asset: { item: { name: { contains: search, mode: 'insensitive' } } } },
        ],
      } : {}),
    };

    const order: 'asc' | 'desc' = query.sortOrder === 'asc' ? 'asc' : 'desc';
    const orderBy: any =
      query.sortBy === 'endDate' ? { endDate: order }
      : query.sortBy === 'type' ? { type: order }
      : { startDate: query.sortBy === 'startDate' ? order : 'desc' };

    const [data, total] = await Promise.all([
      this.prisma.maintenanceRecord.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        include,
        orderBy,
      }),
      this.prisma.maintenanceRecord.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async getOne(id: number) {
    return this.prisma.maintenanceRecord.findUnique({ where: { id }, include });
  }

  async update(id: number, dto: Partial<CreateMaintenanceRecordDto>) {
    const record = await this.prisma.maintenanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Maintenance record not found');

    return this.prisma.maintenanceRecord.update({
      where: { id },
      data: {
        startDate: dto.startDate ? new Date(dto.startDate) : record.startDate,
        type: dto.type ?? record.type,
        notes: dto.notes !== undefined ? dto.notes : record.notes,
        maintainerId: dto.maintainerId !== undefined ? (dto.maintainerId ?? null) : record.maintainerId,
      },
      include,
    });
  }

  async remove(id: number) {
    const record = await this.prisma.maintenanceRecord.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Maintenance record not found');
    return this.prisma.maintenanceRecord.delete({ where: { id } });
  }
}
