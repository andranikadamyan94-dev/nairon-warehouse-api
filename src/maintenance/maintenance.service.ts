import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { AssetStatus } from '../common/enums/asset-status.enum';
import { CreateMaintenanceRecordDto } from './dto/create-maintenance-record.dto';
import { UpdateMaintenanceRecordDto } from './dto/update-maintenance-record.dto';
import { WarehouseActor } from '../auth/actor';
import { ResourceWorkspaceService } from '../common/workspace/resource-workspace.service';

const include = {
  asset: { include: { item: true } },
  maintainer: true,
};

@Injectable()
export class MaintenanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: ResourceWorkspaceService,
  ) {}

  /**
   * May this person raise maintenance on this asset? A record's company is the
   * asset's, through the item and its category, so this is the asset's question
   * asked before the record exists. Shared with the preflight beside it.
   */
  async assertMayMaintain(actor: WarehouseActor, assetId: number) {
    await this.workspaces.assertMayTouch(actor, 'asset', assetId);
  }

  /** May this person change this record? */
  async assertMayEdit(actor: WarehouseActor, id: number) {
    await this.workspaces.assertMayTouch(actor, 'maintenance', id);
  }

  async createRecord(dto: CreateMaintenanceRecordDto, actor: WarehouseActor) {
    const asset = await this.prisma.asset.findUnique({
      where: { id: dto.assetId },
    });
    if (!asset) throw new NotFoundException('Asset not found');
    await this.assertMayMaintain(actor, dto.assetId);
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
        // The author is whoever holds the token. It used to be dto.createdBy —
        // a number in the request body, which anyone could set to anyone.
        createdBy: actor.userId,
      },
      include,
    });
  }

  async finalize(id: number, amount: number, prepaymentAmount?: number, actor?: WarehouseActor) {
    // Money leaves the building on this one, so the workspace question is asked
    // before finance is told anything. Finance is called with a shared secret
    // and learns neither who asked nor from which company, so this is the last
    // place it can be asked at all.
    if (actor) await this.assertMayEdit(actor, id);

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
  async financeCallback(id: number, status: 'APPROVED' | 'REJECTED', rejectionReason?: string) {
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
        // Cleared on approval, so a job rejected once and approved on the
        // second pass does not keep showing the old reason.
        financeRejectionReason: status === 'REJECTED' ? (rejectionReason ?? null) : null,
      },
      include,
    });
  }

  async complete(id: number, actor?: WarehouseActor) {
    if (actor) await this.assertMayEdit(actor, id);

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

  async getUpcomingMaintenance(actor?: WarehouseActor) {
    const scope = actor ? this.workspaces.scopeFor(actor, ['asset', 'item', 'category']) : undefined;

    return this.prisma.maintenanceRecord.findMany({
      where: { endDate: { gte: new Date() }, ...(scope ?? {}) },
      include,
      orderBy: { startDate: 'asc' },
    });
  }

  async getAssetMaintenanceHistory(assetId: number, actor?: WarehouseActor) {
    if (actor) await this.workspaces.assertMayTouch(actor, 'asset', assetId);
    return this.prisma.maintenanceRecord.findMany({
      where: { assetId },
      include,
      orderBy: { startDate: 'desc' },
    });
  }

  async getAll(query: any, actor?: WarehouseActor) {
    const page = Number(query.page ?? 1);
    const limit = Number(query.limit ?? 10);
    const search = query.search as string | undefined;

    // Nothing at all for an unbounded actor, which is everyone here today.
    const scope = actor ? this.workspaces.scopeFor(actor, ['asset', 'item', 'category']) : undefined;

    const where: any = search
      ? {
          ...(scope ?? {}),
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
      : { ...(scope ?? {}) };

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

  async getOne(id: number, actor?: WarehouseActor) {
    // Out of scope reads as missing. The internal route calls this with no
    // actor and is unaffected: finance asking about a record it was told to
    // settle is not a person browsing someone else's stock.
    const scope = actor ? this.workspaces.scopeFor(actor, ['asset', 'item', 'category']) : undefined;
    const record = await this.prisma.maintenanceRecord.findFirst({
      where: { id, ...(scope ?? {}) },
      include,
    });
    // Missing and out of scope answer identically, and both answer 404 the way
    // every other point read in this service does.
    if (!record) throw new NotFoundException('Maintenance record not found');
    return record;
  }

  async update(id: number, dto: UpdateMaintenanceRecordDto, actor: WarehouseActor) {
    const record = await this.prisma.maintenanceRecord.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('Maintenance record not found');
    await this.assertMayEdit(actor, id);
    if (dto.assetId !== undefined && Number(dto.assetId) !== record.assetId) {
      throw new BadRequestException(
        'Սարքավորումը փոխել հնարավոր չէ — ստեղծեք նոր սպասարկման գրառում',
      );
    }

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

  async remove(id: number, actor: WarehouseActor) {
    const record = await this.prisma.maintenanceRecord.findUnique({
      where: { id },
    });
    if (!record) throw new NotFoundException('Maintenance record not found');
    await this.assertMayEdit(actor, id);
    return this.prisma.maintenanceRecord.delete({ where: { id } });
  }
}
