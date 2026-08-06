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
    const asset = await this.prisma.asset.findUnique({
      where: { id: dto.assetId },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    if (asset.status === AssetStatus.RETIRED)
      throw new BadRequestException('Cannot maintain retired asset');

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

  async finalize(id: number, amount: number, prepaymentAmount?: number) {
    const record = await this.prisma.maintenanceRecord.findUnique({
      where: { id },
      include,
    });
    if (!record) throw new NotFoundException('Սպասարկման գրառումը չի գտնվել');
    if (record.status !== 'DRAFT')
      throw new BadRequestException(
        'Միայն նախագիծ գրառումները կարող են ուղարկվել ֆինանսական հաստատման',
      );
    if (!amount || amount <= 0)
      throw new BadRequestException(
        'Ֆինանսական հաստատման համար պարտադիր է նշել գումարը',
      );

    const prepayment = prepaymentAmount ?? 0;
    if (prepayment > amount) {
      throw new BadRequestException(
        `Կանխավճարը (${prepayment}) չի կարող գերազանցել աշխատանքի արժեքը (${amount})`,
      );
    }

    const financeUrl = process.env.FINANCE_API_URL || 'http://localhost:3005';
    const maintainer = record.maintainer ? ` — ${record.maintainer.name}` : '';

    /**
     * Raise one transfer in finance. The deposit carries a ":prepayment" suffix
     * on the ref so finance can tell the two apart; everything that parses the
     * ref reads the id from split(':')[1], which is unchanged.
     */
    const raise = async (
      value: number,
      kind: 'FULL' | 'PREPAYMENT' | 'BALANCE',
      label: string,
    ): Promise<number> => {
      const res = await fetch(`${financeUrl}/api/transfer/external`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SECRET || '',
        },
        body: JSON.stringify({
          amount: value,
          description: `${label} #${id}${maintainer}`,
          externalRef:
            kind === 'PREPAYMENT'
              ? `warehouse_maintenance:${id}:prepayment`
              : `warehouse_maintenance:${id}`,
          paymentKind: kind,
          date: new Date().toISOString(),
        }),
      });
      const body = await res.text();
      if (!res.ok) {
        throw new Error(`finance-api ${res.status} (url: ${financeUrl}): ${body}`);
      }
      return (JSON.parse(body) as { id: number }).id;
    };

    let prepaymentTransferId: number | undefined;
    let financeTransferId: number | undefined;
    try {
      if (prepayment > 0) {
        prepaymentTransferId = await raise(prepayment, 'PREPAYMENT', 'Կանխավճար — սպասարկում');
        // A fully prepaid job has nothing left to bill; a zero transfer would
        // just be a meaningless row in the approval queue.
        if (amount - prepayment > 0.005) {
          financeTransferId = await raise(amount - prepayment, 'BALANCE', 'Մնացորդ — սպասարկում');
        }
      } else {
        financeTransferId = await raise(amount, 'FULL', 'Սպասարկում');
      }
    } catch (e: any) {
      // Same contract as procurement finalize: if finance never received the
      // transfer, fail the request instead of stranding the record in
      // PENDING_FINANCE with no matching transfer on the finance side.
      const detail = e?.message?.startsWith('finance-api')
        ? e.message
        : `network error reaching ${financeUrl}: ${e?.message ?? e}`;
      throw new BadRequestException(`Finance notification failed — ${detail}`);
    }

    return this.prisma.maintenanceRecord.update({
      where: { id },
      data: {
        amount,
        prepaymentAmount: prepayment > 0 ? prepayment : null,
        status: 'PENDING_FINANCE',
        ...(financeTransferId ? { financeTransferId } : {}),
        ...(prepaymentTransferId ? { prepaymentTransferId } : {}),
      },
      include,
    });
  }

  /**
   * Idempotent for the same reason as the procurement callback: finance treats
   * a non-2xx as a hard error and rolls its own approval back, so re-notifying
   * an already-updated record must not fail.
   */
  async financeCallback(id: number, status: 'APPROVED' | 'REJECTED') {
    const record = await this.prisma.maintenanceRecord.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('Maintenance record not found');

    const target = status === 'APPROVED' ? 'FINANCE_APPROVED' : 'FINANCE_REJECTED';
    if (record.status === target) return record;

    if (record.status !== 'PENDING_FINANCE')
      throw new BadRequestException(
        `Maintenance record #${id} is ${record.status}, not awaiting finance approval`,
      );

    return this.prisma.maintenanceRecord.update({
      where: { id },
      data: {
        status: status === 'APPROVED' ? 'FINANCE_APPROVED' : 'FINANCE_REJECTED',
      },
      include,
    });
  }

  async complete(id: number) {
    const record = await this.prisma.maintenanceRecord.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('Maintenance record not found');
    if (record.status === 'COMPLETED')
      throw new BadRequestException('Maintenance is already completed');
    if (record.status === 'DRAFT')
      throw new BadRequestException('Cannot complete a draft record');

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

    const where: any = search
      ? {
          OR: [
            {
              asset: {
                serialNumber: { contains: search, mode: 'insensitive' },
              },
            },
            {
              asset: {
                item: { name: { contains: search, mode: 'insensitive' } },
              },
            },
          ],
        }
      : {};

    const order: 'asc' | 'desc' = query.sortOrder === 'asc' ? 'asc' : 'desc';
    // Every sort ends with id, because none of these columns is unique.
    // Without a tiebreaker Postgres is free to return tied rows in a different
    // arrangement per query, and skip/take then slices a different arrangement
    // for each page: rows appear on two pages and others on none. With most
    // jobs sharing a start date that was not theoretical — records 20 to 31
    // could not be reached from the list at all.
    const orderBy: any[] =
      query.sortBy === 'endDate'
        ? [{ endDate: order }, { id: 'desc' }]
        : query.sortBy === 'type'
          ? [{ type: order }, { id: 'desc' }]
          : [{ startDate: query.sortBy === 'startDate' ? order : 'desc' }, { id: 'desc' }];

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
    const record = await this.prisma.maintenanceRecord.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('Maintenance record not found');

    return this.prisma.maintenanceRecord.update({
      where: { id },
      data: {
        startDate: dto.startDate ? new Date(dto.startDate) : record.startDate,
        type: dto.type ?? record.type,
        notes: dto.notes !== undefined ? dto.notes : record.notes,
        maintainerId:
          dto.maintainerId !== undefined
            ? (dto.maintainerId ?? null)
            : record.maintainerId,
      },
      include,
    });
  }

  async remove(id: number) {
    const record = await this.prisma.maintenanceRecord.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('Maintenance record not found');
    return this.prisma.maintenanceRecord.delete({ where: { id } });
  }
}
