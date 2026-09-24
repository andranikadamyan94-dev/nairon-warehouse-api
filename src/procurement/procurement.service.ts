import { settleStoredQty } from '../common/stored-quantity';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'prisma/prisma.service';
import { ProcurementOrderStatus } from '../common/enums/procurement-order-status.enum';
import { CreateProcurementDto } from './dto/create-procurement.dto';
import { UpdateProcurementDto } from './dto/update-procurement.dto';
import { FileService } from '../common/file.service';
import { StockAlertService } from '../common/notifications/stock-alert.service';
import { WarehouseNotificationsService } from '../common/notifications/notifications.service';
import { ReceiveDeliveryDto } from './dto/receive-delivery.dto';
import { requireInternalSecret } from '../common/internal-headers';
import { requireFinanceUrl } from '../common/finance-url';
import { transferOperationKey } from '../common/operation-key';
import { UsersPrismaService } from '../common/users-prisma.service';

/** 2026-09-25: an order needs this right, held in the order's organization, before finance hears of it. */
export const APPROVE_ORDER_PERMISSION = 'approve_purchase_order';

const include = {
  supplier: true,
  items: { include: { item: true } },
  // Delivery history — an order can arrive in instalments, each with its own
  // receipt document.
  deliveries: {
    orderBy: { receivedAt: 'desc' as const },
    include: { items: true },
  },
  // Money raised for the order, corrections included (2026-09-22).
  payments: { orderBy: { createdAt: 'asc' as const } },
};

@Injectable()
export class ProcurementService {
  private readonly logger = new Logger(ProcurementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
    private readonly stockAlerts: StockAlertService,
    private readonly notifications: WarehouseNotificationsService,
    private readonly usersPrisma: UsersPrismaService,
  ) {}

  async findAll(query?: {
    status?: string;
    supplierId?: string;
    search?: string;
    page?: string;
    limit?: string;
    sortBy?: string;
    sortOrder?: string;
  }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);

    const where: any = {};
    if (query?.status) where.status = query.status;
    if (query?.supplierId) where.supplierId = Number(query.supplierId);
    if (query?.search) {
      where.OR = [
        { supplier: { name: { contains: query.search, mode: 'insensitive' } } },
        { notes: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const order: 'asc' | 'desc' = query?.sortOrder === 'asc' ? 'asc' : 'desc';
    // id last, always. Sorting by status is the sharp case — there are only a
    // handful of distinct values, so nearly every row is tied, and without a
    // tiebreaker skip/take slices a differently-arranged result per page:
    // orders appear twice and others never appear at all.
    const orderBy: any[] =
      query?.sortBy === 'status'
        ? [{ status: order }, { id: 'desc' }]
        : [
            { createdAt: query?.sortBy === 'createdAt' ? order : 'desc' },
            { id: 'desc' },
          ];

    const [data, total] = await Promise.all([
      this.prisma.procurementOrder.findMany({
        where,
        include,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.procurementOrder.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async findOne(id: number) {
    const order = await this.prisma.procurementOrder.findUnique({
      where: { id },
      include,
    });
    if (!order) throw new NotFoundException('Գնման պատվերը չի գտնվել');
    return order;
  }

  async create(
    dto: CreateProcurementDto,
    createdBy?: number,
    activeEntityId?: number | null,
  ) {
    return this.prisma.procurementOrder.create({
      data: {
        // Stamped reliably: cancel is creator-only, and a null creator would
        // let ANY manage_procurement holder through that gate.
        createdBy: createdBy ?? null,
        // The organization the purchase is for: what the form says, else the
        // one the buyer is acting as.
        entityId: dto.entityId ?? activeEntityId ?? null,
        supplierId: dto.supplierId ?? null,
        notes: dto.notes ?? null,
        prepaymentAmount: dto.prepaymentAmount ?? null,
        items: {
          create: dto.items.map((i) => ({
            itemId: i.itemId,
            quantity: i.quantity,
            unitPrice: i.unitPrice ?? null,
          })),
        },
      },
      include,
    });
  }

  /**
   * Re-file an order under another organization (2026-09-10). Super-admins
   * only: this is the correction tool for the orders placed before an order
   * carried an organization at all, and for the occasional purchase booked
   * against the wrong one.
   *
   * The money follows, including transfers finance has already booked: that
   * expense is exactly what was filed under the wrong organization, so it
   * moves too and finance writes an approval-log line on each. Their ids come
   * back so the client can say how many booked transfers were re-filed.
   */
  async setEntity(id: number, entityId: number | null, isSuperAdmin: boolean) {
    if (!isSuperAdmin) {
      throw new ForbiddenException(
        'Պատվերի կազմակերպությունը կարող է փոխել միայն ադմինիստրատորը',
      );
    }
    const order = await this.findOne(id);
    if (((order as any).entityId ?? null) === (entityId ?? null)) return order;

    const updated = await this.prisma.procurementOrder.update({
      where: { id },
      data: { entityId: entityId ?? null },
      include,
    });

    let financeMovedBooked: number[] = [];
    const financeUrl = requireFinanceUrl();
    try {
      const res = await fetch(
        `${financeUrl}/api/transfer/external/entity-by-ref`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': requireInternalSecret(),
          },
          body: JSON.stringify({
            externalRef: `warehouse_procurement:${id}`,
            entityId: entityId ?? null,
          }),
        },
      );
      if (res.ok) {
        const body = await res.json();
        financeMovedBooked = body?.movedBooked ?? [];
        this.logger.log(
          `Order #${id}: finance transfers re-filed under entity ${entityId ?? 'none'} ` +
            `(${(body?.moved ?? []).length} moved, ${financeMovedBooked.length} of them already booked)`,
        );
      } else {
        this.logger.warn(
          `Order #${id}: finance refused the organization change (${res.status})`,
        );
      }
    } catch (e: any) {
      // The order is the record of truth for what was bought for whom; a
      // finance outage must not undo that. Reported, not thrown.
      this.logger.warn(
        `Order #${id}: could not reach finance to re-file transfers — ${e?.message ?? e}`,
      );
    }

    return { ...updated, financeMovedBooked };
  }

  async update(
    id: number,
    dto: UpdateProcurementDto,
    actor: { isSuperAdmin?: boolean; userId?: number } = {},
  ) {
    const order = await this.findOne(id);
    // A settled order (received, or closed short) is final for everyone but a
    // super-admin, who may still correct the supplier, the note and the line
    // prices — never the goods or the quantities, which are already on the
    // shelf and billed. See overrideSettled.
    const settled = (['RECEIVED', 'CLOSED_SHORT'] as string[]).includes(order.status);
    if (settled && !actor.isSuperAdmin) {
      throw new BadRequestException('Ստացված պատվերը հնարավոր չէ խմբագրել');
    }
    if (settled) return this.overrideSettled(order, dto, actor.userId);

    // The deposit is frozen once the order leaves DRAFT, because finalize has
    // already raised transfers for it. Changing it afterwards would leave the
    // settlement maths disagreeing with the money actually raised: a deposit
    // edited down to zero after a 30,000 deposit was raised would bill the
    // full delivered value again on top of it.
    const changesPrepayment =
      dto.prepaymentAmount !== undefined &&
      (dto.prepaymentAmount ?? null) !== (order.prepaymentAmount ?? null);
    if (changesPrepayment && order.status !== ProcurementOrderStatus.DRAFT) {
      throw new BadRequestException(
        'Կանխավճարը հնարավոր չէ փոխել այն բանից հետո, երբ պատվերն ուղարկվել է ֆինանս',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.items !== undefined) {
        await tx.procurementOrderItem.deleteMany({ where: { orderId: id } });
        await tx.procurementOrderItem.createMany({
          data: dto.items.map((i) => ({
            orderId: id,
            itemId: i.itemId,
            quantity: i.quantity,
            unitPrice: i.unitPrice ?? null,
          })),
        });
      }

      return tx.procurementOrder.update({
        where: { id },
        data: {
          supplierId: dto.supplierId ?? undefined,
          notes: dto.notes ?? undefined,
          prepaymentAmount: dto.prepaymentAmount ?? undefined,
        },
        include,
      });
    });
  }

  /**
   * The procurement side's confirmation (2026-09-01 split): finance approved
   * the money, procurement placed the order with the supplier — from here the
   * order belongs to warehouse receiving (the Ընդունումներ page). Only this
   * transition may set ORDERED; the old free-form marking allowed it from any
   * state, which let orders skip finance entirely.
   */
  async confirmOrdered(id: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.FINANCE_APPROVED) {
      throw new BadRequestException(
        'Միայն ֆինանսների կողմից հաստատված պատվերը կարող է հաստատվել որպես պատվիրված',
      );
    }
    return this.prisma.procurementOrder.update({
      where: { id },
      data: { status: ProcurementOrderStatus.ORDERED },
      include,
    });
  }

  /**
   * The warehouse receiving list: confirmed orders awaiting delivery, orders
   * mid-delivery, and (for the page's history tab) recently settled ones.
   */
  async findReceivable(query?: {
    history?: string;
    page?: string;
    limit?: string;
  }) {
    const page = Number(query?.page ?? 1);
    const limit = Number(query?.limit ?? 20);
    const statuses =
      query?.history === '1'
        ? [ProcurementOrderStatus.RECEIVED, ProcurementOrderStatus.CLOSED_SHORT]
        : [
            ProcurementOrderStatus.ORDERED,
            ProcurementOrderStatus.PARTIALLY_RECEIVED,
          ];
    const where = { status: { in: statuses } };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.procurementOrder.findMany({
        where,
        include,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.procurementOrder.count({ where }),
    ]);
    return { data, total, page, limit };
  }

  async updateStatus(id: number, status: ProcurementOrderStatus) {
    const order = await this.findOne(id);
    if (order.status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Պատվերն արդեն ստացվել է');
    }
    if (order.status === ProcurementOrderStatus.CANCELLED) {
      throw new BadRequestException('Պատվերը չեղարկված է');
    }
    return this.prisma.procurementOrder.update({
      where: { id },
      data: { status },
      include,
    });
  }

  /**
   * Record a delivery against an order. Orders can arrive in instalments, so
   * this takes per-line quantities; omitting `lines` delivers the whole
   * outstanding remainder, which is what the old all-or-nothing receive did.
   *
   * Stock, assets and inventory movements all follow what actually ARRIVED —
   * never the ordered quantity.
   */
  async receive(
    id: number,
    receiptFile?: Express.Multer.File,
    dto?: ReceiveDeliveryDto,
    receivedBy?: number,
  ) {
    const order = await this.findOne(id);
    if (order.status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Պատվերն արդեն ստացվել է');
    }
    if (order.status === ProcurementOrderStatus.CLOSED_SHORT) {
      throw new BadRequestException(
        'Պատվերը փակված է թերի — այլևս հնարավոր չէ ընդունել',
      );
    }
    if (order.status === ProcurementOrderStatus.CANCELLED) {
      throw new BadRequestException('Պատվերը չեղարկված է');
    }
    if (order.status === ProcurementOrderStatus.PENDING_FINANCE_APPROVAL) {
      throw new BadRequestException('Պատվերը սպասում է ֆինանսական հաստատման');
    }
    if (order.status === ProcurementOrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Պատվերը սպասում է հաստատման');
    }
    if (order.status === ProcurementOrderStatus.DRAFT) {
      throw new BadRequestException(
        'Ընդունելուց առաջ պատվերը պետք է հաստատվի ֆինանսի կողմից',
      );
    }
    if (order.status === ProcurementOrderStatus.FINANCE_REJECTED) {
      throw new BadRequestException(
        'Պատվերը մերժվել է ֆինանսի կողմից և չի կարող ընդունվել',
      );
    }
    // The 2026-09-01 split: after finance approval the PROCUREMENT side must
    // first confirm the purchase (ORDERED) — only then does the order reach
    // the warehouse receiving list and become receivable.
    if (order.status === ProcurementOrderStatus.FINANCE_APPROVED) {
      throw new BadRequestException(
        'Պատվերը դեռ հաստատված չէ գնումների կողմից որպես պատվիրված',
      );
    }
    // 2026-09-16: the receipt scan is optional; the document number below is
    // what a delivery is filed under.
    // The paper's own number (invoice/waybill №) — without it the stored file
    // can't be reconciled against the supplier's books.
    const documentNumber = dto?.documentNumber?.trim();
    if (!documentNumber) {
      throw new BadRequestException('Փաստաթղթի համարը պարտադիր է');
    }

    const remaining = (line: { quantity: number; receivedQuantity: number }) =>
      line.quantity - (line.receivedQuantity ?? 0);

    // No explicit lines → deliver everything still outstanding.
    const requested: {
      orderItemId: number;
      quantity: number;
      unitPrice?: number;
    }[] = dto?.lines?.length
      ? dto.lines
      : order.items
          .filter((l) => remaining(l) > 0)
          .map((l) => ({ orderItemId: l.id, quantity: remaining(l) }));

    if (!requested.length) {
      throw new BadRequestException('Այս պատվերով մնացորդ չկա');
    }

    // Validate before touching anything — a delivery is all-or-nothing.
    const byId = new Map(order.items.map((l) => [l.id, l]));
    const planned: {
      line: (typeof order.items)[number];
      quantity: number;
      unitPrice?: number;
    }[] = [];
    for (const entry of requested) {
      const line = byId.get(entry.orderItemId);
      if (!line) {
        throw new BadRequestException(
          `Line ${entry.orderItemId} is not on order #${id}`,
        );
      }
      if (entry.quantity <= 0) {
        throw new BadRequestException(
          `Delivered quantity must be greater than 0`,
        );
      }
      // Over-delivery is rejected: silently absorbing extra stock would break
      // reconciliation against what finance was billed.
      if (entry.quantity > remaining(line) + 1e-9) {
        throw new BadRequestException(
          `Cannot receive ${entry.quantity} of "${line.item.name}" — only ${remaining(line)} outstanding`,
        );
      }
      if (entry.unitPrice != null && !(entry.unitPrice >= 0)) {
        throw new BadRequestException('Գինը պետք է լինի զրո կամ ավելի');
      }
      planned.push({
        line,
        quantity: entry.quantity,
        unitPrice: entry.unitPrice ?? undefined,
      });
    }

    // The receipt file is optional (2026-09-16): the document number is the
    // record, the scan is a convenience. No file, no URL — never a crash on
    // `undefined.mimetype`.
    const receiptUrl = receiptFile
      ? this.fileService.upload(receiptFile)
      : null;
    const isFirstDelivery = !order.receivedAt;

    // Large asset orders (bulk createMany) need more than the 5s default
    const result = await this.prisma.$transaction(
      async (tx) => {
        const delivery = await tx.procurementDelivery.create({
          data: {
            orderId: id,
            receiptUrl,
            documentNumber,
            notes: dto?.notes,
            receivedBy,
          },
        });

        for (const { line, quantity, unitPrice } of planned) {
          // The document's price is the truth about what this stock cost.
          const cost =
            unitPrice ?? line.invoicedUnitPrice ?? line.unitPrice ?? null;
          await tx.procurementDeliveryItem.create({
            data: {
              deliveryId: delivery.id,
              orderItemId: line.id,
              quantity,
              unitPrice: unitPrice ?? null,
            },
          });

          if (line.item.type === 'ASSET') {
            // One bulk insert — creating rows one-by-one blew the transaction
            // timeout on large orders (e.g. 100k units → 100k round trips).
            // Counts the DELIVERED quantity, not the ordered one.
            const count = Math.round(quantity);
            if (count > 0) {
              await tx.asset.createMany({
                data: Array.from({ length: count }, () => ({
                  itemId: line.itemId,
                })),
              });
            }
          } else {
            await tx.item.update({
              where: { id: line.itemId },
              data: { quantity: { increment: quantity } },
            });
            await settleStoredQty(tx, { itemId: line.itemId });
          }

          await tx.procurementOrderItem.update({
            where: { id: line.id },
            data: {
              receivedQuantity: { increment: quantity },
              ...(unitPrice != null ? { invoicedUnitPrice: unitPrice } : {}),
            },
          });

          await tx.inventoryMovement.create({
            data: {
              itemId: line.itemId,
              quantity,
              type: 'IN',
              supplierId: order.supplierId ?? undefined,
              // #2042: the purchase price is this receipt's real cost — freeze it.
              unitCost: cost,
              totalCost: cost != null ? quantity * cost : null,
              notes: `Գնման պատվեր #${id}, առաքում #${delivery.id}, փաստ. № ${documentNumber}`,
            },
          });
        }

        // Complete only when every line is fully satisfied.
        const lines = await tx.procurementOrderItem.findMany({
          where: { orderId: id },
        });
        const complete = lines.every(
          (l) => l.receivedQuantity >= l.quantity - 1e-9,
        );

        return tx.procurementOrder.update({
          where: { id },
          data: {
            status: complete
              ? ProcurementOrderStatus.RECEIVED
              : ProcurementOrderStatus.PARTIALLY_RECEIVED,
            // The order-level receipt stays the FIRST one, so existing views
            // and the finance flow keep behaving as before.
            ...(isFirstDelivery ? { receivedAt: new Date(), receiptUrl } : {}),
          },
          include,
        });
      },
      { timeout: 60_000 },
    );

    // Restocking mainly clears the low-stock latch — only for what arrived.
    this.stockAlerts.check(
      planned
        .filter((p) => p.line.item.type !== 'ASSET')
        .map((p) => p.line.itemId),
    );

    const complete = result.status === ProcurementOrderStatus.RECEIVED;
    // #1885: requisitions this order was raised for are now satisfied.
    if (complete) {
      await this.prisma.purchaseRequisition
        .updateMany({
          where: { orderId: id, status: 'APPROVED' },
          data: { status: 'FULFILLED' },
        })
        .catch(() => {});
    }

    // On completion, reconcile finance against what actually arrived. Normally
    // that equals the ordered value and settleWithFinance is a no-op; it only
    // does work if quantities ended up differing.
    if (complete) {
      await this.reconcileWithFinance(
        result,
        this.invoicedValue(result.items),
        'Պատվերն ամբողջությամբ ստացվել է',
        { documentNumber, createdBy: receivedBy ?? null },
      );
    }
    void this.notifications.send({
      permissions: ['receive_procurement_alerts', 'manage_warehouse'],
      title: complete
        ? 'Գնման պատվերը ստացվել է'
        : 'Գնման պատվերը ստացվել է մասնակի',
      body: complete
        ? `Գնման պատվեր #${id} ամբողջությամբ ստացվել է և պաշարը թարմացվել է։`
        : `Գնման պատվեր #${id}-ի մի մասը ստացվել է։ Մնացած քանակը դեռ սպասվում է։`,
      path: '/procurement',
      details: [
        { label: 'Պատվեր', value: `#${id}` },
        ...(order.supplier?.name
          ? [{ label: 'Մատակարար', value: order.supplier.name }]
          : []),
        { label: 'Ստացված այս անգամ', value: String(planned.length) },
        ...(complete
          ? []
          : [{ label: 'Կարգավիճակ', value: 'Մասնակի ստացված' }]),
      ],
    });

    return result;
  }

  /**
   * Bring finance in line with what the supplier actually billed (2026-09-22).
   *
   * The order was authorized at the ordered value. Once the goods and the
   * invoice are here, the invoiced value can differ — a short delivery, or
   * prices that changed (VAT left out of the order was today's case). This
   * step settles the difference:
   *
   *   1. While the balance transfer is still unbooked (PENDING/APPROVED) and
   *      no correction has been raised yet, its amount is corrected in place —
   *      finance simply books the right figure.
   *   2. Otherwise the money finance has, or will book, is compared with the
   *      invoiced value and the difference becomes ONE new transfer under the
   *      same order reference: an ADJUSTMENT expense when the invoice is
   *      higher, a REFUND income when it is lower. Both go through finance's
   *      normal approval; the booked transfers are never rewritten.
   *
   * `strict` (the amendment route) throws on a finance failure so the person
   * sees it; the receipt route stays best-effort and notifies instead, because
   * failing to reconcile must never block putting stock on the shelf.
   */
  private async reconcileWithFinance(
    order: any,
    invoicedValue: number,
    reason: string,
    meta: { documentNumber?: string | null; createdBy?: number | null } = {},
    strict = false,
  ): Promise<{
    action: 'none' | 'adjusted' | 'raised' | 'failed';
    delta: number;
    transferId?: number;
  }> {
    const prepaid = order.prepaymentAmount ?? 0;
    const orderedValue = order.items.reduce(
      (sum: number, l: any) => sum + l.quantity * (l.unitPrice ?? 0),
      0,
    );
    const payments = await this.prisma.procurementPayment.findMany({
      where: { orderId: order.id },
      orderBy: { createdAt: 'asc' },
    });
    const live = payments.filter((p) => p.status !== 'REJECTED');
    const balance = live.find(
      (p) => p.type === 'BALANCE' && p.financeTransferId,
    );
    const corrected = live.some(
      (p) => p.type === 'ADJUSTMENT' || p.type === 'REFUND',
    );
    if (prepaid > 0 && invoicedValue < prepaid - 0.005) {
      void this.notifications.send({
        permissions: ['receive_procurement_alerts', 'manage_warehouse'],
        path: '/procurement',
        title: 'Կանխավճարը գերազանցում է ստացվածը',
        body:
          `Պատվեր #${order.id}: կանխավճար ${prepaid}, ստացվել է ${invoicedValue}-ի չափով։ ` +
          `Մատակարարը պարտք է ${Math.round((prepaid - invoicedValue) * 100) / 100}։ Պահանջեք վերադարձ։`,
      });
    }
    const fail = async (detail: string) => {
      this.logger.error(
        `Order #${order.id}: finance reconcile failed — ${detail}`,
      );
      if (strict)
        throw new BadRequestException(
          `Ֆինանսի հետ ճշգրտումը չհաջողվեց — ${detail}`,
        );
      void this.notifications.send({
        permissions: ['receive_procurement_alerts', 'manage_warehouse'],
        title: 'Ֆինանսական գումարը չհամապատասխանեց',
        body:
          `Գնման պատվեր #${order.id}-ի գումարը չհաջողվեց ճշգրտել։ ` +
          `Հաստատվել է ${Math.round(orderedValue).toLocaleString('hy-AM')} ֏, ` +
          `փաստացի արժեքը ${Math.round(invoicedValue).toLocaleString('hy-AM')} ֏ է։ ` +
          `Անհրաժեշտ է ձեռքով ճշգրտում ֆինանսների հետ։`,
        path: '/procurement',
        details: [{ label: 'Պատվեր', value: `#${order.id}` }],
      });
      return { action: 'failed' as const, delta: 0 };
    };
    let financeUrl: string, internalKey: string;
    try {
      financeUrl = requireFinanceUrl();
      internalKey = requireInternalSecret();
    } catch (e: any) {
      return fail(e?.message ?? 'finance is not configured');
    }
    const headers = {
      'Content-Type': 'application/json',
      'x-internal-secret': internalKey,
    };
    // 1. Correct the unbooked balance in place.
    if (balance && !corrected) {
      const balanceDue = Math.max(0, invoicedValue - prepaid);
      if (Math.abs(balance.amount - balanceDue) < 0.005)
        return { action: 'none', delta: 0 };
      let res: Response;
      try {
        res = await fetch(
          `${financeUrl}/api/transfer/external/${balance.financeTransferId}/amount`,
          {
            method: 'PATCH',
            headers,
            body: JSON.stringify({ amount: balanceDue, reason }),
          },
        );
      } catch (e: any) {
        return fail(`network error reaching finance: ${e?.message ?? e}`);
      }
      if (res.ok) {
        await this.prisma.procurementPayment.update({
          where: { id: balance.id },
          data: {
            amount: balanceDue,
            status: 'ADJUSTED',
            note: reason,
            documentNumber: meta.documentNumber ?? undefined,
          },
        });
        this.logger.log(
          `Order #${order.id}: balance transfer ${balance.financeTransferId} corrected ${balance.amount} → ${balanceDue}`,
        );
        return {
          action: 'adjusted',
          delta: balanceDue - balance.amount,
          transferId: balance.financeTransferId!,
        };
      }
      // 409 = already booked: the difference becomes its own transfer below.
      if (res.status !== 409)
        return fail(
          `finance-api ${res.status} ${await res.text().catch(() => '')}`,
        );
    }
    // 2. The difference between the invoice and what finance has.
    const covered = payments.length
      ? live.reduce(
          (sum, p) => sum + (p.type === 'REFUND' ? -p.amount : p.amount),
          0,
        )
      : order.financeTransferId || prepaid > 0
        ? orderedValue
        : 0;
    const delta = Math.round((invoicedValue - covered) * 100) / 100;
    if (Math.abs(delta) < 0.005) return { action: 'none', delta: 0 };
    const kind: 'ADJUSTMENT' | 'REFUND' = delta > 0 ? 'ADJUSTMENT' : 'REFUND';
    const attempt = payments.filter((p) => p.type === kind).length + 1;
    const supplierSuffix = order.supplier ? ` — ${order.supplier.name}` : '';
    let transferId: number;
    try {
      const res = await fetch(`${financeUrl}/api/transfer/external`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          amount: Math.abs(delta),
          type: kind === 'ADJUSTMENT' ? 'EXPENSE' : 'INCOME',
          entityId: order.entityId ?? undefined,
          description:
            (kind === 'ADJUSTMENT'
              ? 'Գնի ճշգրտում — գնման պատվեր'
              : 'Վերադարձ մատակարարից — գնման պատվեր') +
            ` #${order.id}${supplierSuffix}` +
            (meta.documentNumber ? ` · փաստ. № ${meta.documentNumber}` : '') +
            ` · ${reason}`,
          externalRef: `warehouse_procurement:${order.id}:${kind.toLowerCase()}`,
          operationKey: transferOperationKey(
            'warehouse_procurement',
            order.id,
            kind,
            attempt,
          ),
          paymentKind: kind,
        }),
      });
      const body = await res.text();
      if (!res.ok) return fail(`finance-api ${res.status}: ${body}`);
      transferId = JSON.parse(body).id;
    } catch (e: any) {
      if (e instanceof BadRequestException) throw e;
      return fail(`network error reaching finance: ${e?.message ?? e}`);
    }
    await this.prisma.procurementPayment.create({
      data: {
        orderId: order.id,
        type: kind,
        amount: Math.abs(delta),
        financeTransferId: transferId,
        status: 'PENDING',
        note: reason,
        documentNumber: meta.documentNumber ?? null,
        createdBy: meta.createdBy ?? null,
      },
    });
    this.logger.log(
      `Order #${order.id}: ${kind} of ${Math.abs(delta)} raised as finance transfer ${transferId}`,
    );
    return { action: 'raised', delta, transferId };
  }
  /**
   * Super-admin edit of a settled order (2026-09-22, owner's ask): supplier,
   * note and line prices only. A changed ordered price on a line that has no
   * invoiced price is what the stock cost and finance were told, so the
   * movements are re-costed and finance is reconciled (best effort, as at
   * receipt). Anything touching the goods or the quantities is refused.
   */
  private async overrideSettled(order: any, dto: UpdateProcurementDto, userId?: number) {
    if (dto.entityId !== undefined && (dto.entityId ?? null) !== (order.entityId ?? null))
      throw new BadRequestException('Կազմակերպությունը փոխվում է առանձին գործողությամբ');
    const priceChanges = new Map<number, { line: any; price: number | null }>();
    if (dto.items !== undefined) {
      const byItem = new Map<number, any>(order.items.map((l: any) => [l.itemId, l]));
      if (
        dto.items.length !== order.items.length ||
        dto.items.some((i) => !byItem.has(i.itemId))
      )
        throw new BadRequestException('Ստացված պատվերի ապրանքները չեն փոխվում, միայն գները');
      for (const i of dto.items) {
        const line = byItem.get(i.itemId)!;
        if (Math.abs(i.quantity - line.quantity) > 1e-9)
          throw new BadRequestException('Ստացված պատվերի քանակները չեն փոխվում');
        if ((i.unitPrice ?? null) !== (line.unitPrice ?? null))
          priceChanges.set(line.id, { line, price: i.unitPrice ?? null });
      }
    }
    const changed: string[] = [];
    await this.prisma.$transaction(async (tx) => {
      const data: any = {};
      if (dto.supplierId !== undefined && (dto.supplierId ?? null) !== (order.supplierId ?? null)) {
        data.supplierId = dto.supplierId ?? null;
        changed.push('մատակարար');
      }
      if (dto.notes !== undefined && (dto.notes ?? null) !== (order.notes ?? null)) {
        data.notes = dto.notes ?? null;
        changed.push('նշում');
      }
      if (Object.keys(data).length) await tx.procurementOrder.update({ where: { id: order.id }, data });
      for (const [orderItemId, { line, price }] of priceChanges) {
        await tx.procurementOrderItem.update({ where: { id: orderItemId }, data: { unitPrice: price } });
        // Without an invoiced price the ordered one is the cost of the stock.
        if (line.invoicedUnitPrice == null) await this.recostMovements(tx, order.id, line.itemId, price ?? 0);
        changed.push(`${line.item?.name ?? line.itemId}: ${line.unitPrice ?? '—'} → ${price ?? '—'}`);
      }
    });
    if (!changed.length) return this.findOne(order.id);
    this.logger.warn(`Order #${order.id}: settled order edited by super-admin ${userId ?? '?'} — ${changed.join(', ')}`);
    void this.notifications.send({
      permissions: ['receive_procurement_alerts', 'manage_warehouse'],
      title: 'Ստացված պատվերը խմբագրվել է',
      body: `Գնման պատվեր #${order.id}-ը փոփոխվել է սուպեր-ադմինի կողմից՝ ${changed.join(', ')}։`,
      path: '/procurement',
      details: [{ label: 'Պատվեր', value: `#${order.id}` }],
    });
    if (priceChanges.size) {
      const fresh = await this.findOne(order.id);
      await this.reconcileWithFinance(
        fresh,
        this.invoicedValue(fresh.items),
        'Պատվերը խմբագրվել է սուպեր-ադմինի կողմից',
        { createdBy: userId ?? null },
      );
    }
    return this.findOne(order.id);
  }
  /** The stock that came in under an order now costs `price` per unit. */
  private async recostMovements(tx: any, orderId: number, itemId: number, price: number) {
    const movements = await tx.inventoryMovement.findMany({
      where: { itemId, type: 'IN', notes: { startsWith: `Գնման պատվեր #${orderId},` } },
      select: { id: true, quantity: true },
    });
    for (const m of movements)
      await tx.inventoryMovement.update({
        where: { id: m.id },
        data: { unitCost: price, totalCost: m.quantity * price },
      });
  }
  /** Value of what has actually been received on an order, at invoiced prices where known. */
  private invoicedValue(items: any[]): number {
    return items.reduce(
      (sum, l) =>
        sum +
        (l.receivedQuantity ?? 0) * (l.invoicedUnitPrice ?? l.unitPrice ?? 0),
      0,
    );
  }
  /**
   * Price correction on a received order (2026-09-22): the supplier's invoice
   * differed from the ordered prices. Prices are written first — the order
   * must show what was actually billed — then finance is reconciled; a
   * finance failure is reported and the same amendment can be sent again.
   */
  async amend(
    id: number,
    dto: {
      lines: { orderItemId: number; unitPrice: number }[];
      reason: string;
      documentNumber?: string;
    },
    userId?: number,
  ) {
    const order = await this.findOne(id);
    if (
      !(
        ['PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED_SHORT'] as string[]
      ).includes(order.status)
    )
      throw new BadRequestException(
        'Գները կարող են ճշգրտվել միայն ստացված պատվերի համար',
      );
    const reason = dto.reason?.trim();
    if (!reason) throw new BadRequestException('Նշեք ճշգրտման պատճառը');
    const byId = new Map(order.items.map((l) => [l.id, l]));
    const changes = new Map<number, number>();
    for (const line of dto.lines ?? []) {
      const item = byId.get(line.orderItemId);
      if (!item)
        throw new BadRequestException(
          `Line ${line.orderItemId} is not on order #${id}`,
        );
      if (!(line.unitPrice >= 0))
        throw new BadRequestException('Գինը պետք է լինի զրո կամ ավելի');
      if (
        Math.abs(
          (item.invoicedUnitPrice ?? item.unitPrice ?? 0) - line.unitPrice,
        ) >= 0.005
      )
        changes.set(line.orderItemId, line.unitPrice);
    }
    if (changes.size) {
      await this.prisma.$transaction(async (tx) => {
        for (const [orderItemId, unitPrice] of changes) {
          const item = byId.get(orderItemId)!;
          await tx.procurementOrderItem.update({
            where: { id: orderItemId },
            data: { invoicedUnitPrice: unitPrice },
          });
          // The stock that came in under this order now costs what the invoice says.
          await this.recostMovements(tx, id, item.itemId, unitPrice);
        }
      });
    }
    const fresh = await this.findOne(id);
    const result = await this.reconcileWithFinance(
      fresh,
      this.invoicedValue(fresh.items),
      reason,
      {
        documentNumber: dto.documentNumber?.trim() || null,
        createdBy: userId ?? null,
      },
      true,
    );
    if (!changes.size && result.action === 'none')
      throw new BadRequestException('Գները չեն փոխվել և ճշգրտելու բան չկա');
    return { ...(await this.findOne(id)), amendment: result };
  }
  /**
   * Cancel an order (2026-09-01 rules). Only the creator — or a super-admin —
   * may cancel. Anything up to and including ORDERED cancels outright: the
   * finance transfers (balance AND prepayment, by ref) are voided unless
   * already booked, and the audience of the procurement alerts is notified.
   * Mid-delivery (PARTIALLY_RECEIVED) only the remainder cancels — received
   * stock stays, which is exactly close-short semantics, so it delegates
   * there. RECEIVED/CLOSED_SHORT/CANCELLED are final.
   */
  async cancel(
    id: number,
    userId?: number,
    isSuperAdmin = false,
    reason?: string,
  ) {
    const order = await this.findOne(id);
    const status = order.status as ProcurementOrderStatus;
    if (status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Ստացված պատվերը չի կարող չեղարկվել');
    }
    if (status === ProcurementOrderStatus.CLOSED_SHORT) {
      throw new BadRequestException('Պատվերն արդեն փակված է');
    }
    if (status === ProcurementOrderStatus.CANCELLED) {
      throw new BadRequestException('Պատվերն արդեն չեղարկված է');
    }
    if (
      !isSuperAdmin &&
      order.createdBy != null &&
      order.createdBy !== userId
    ) {
      throw new ForbiddenException(
        'Միայն պատվերը ստեղծողը կարող է չեղարկել այն',
      );
    }

    if (status === ProcurementOrderStatus.PARTIALLY_RECEIVED) {
      return this.closeShort(id, reason ?? 'Չեղարկվել է ստեղծողի կողմից');
    }

    // Void the money before flipping the status: if finance is unreachable the
    // cancel fails whole, rather than leaving a live transfer for a dead order.
    let financeNote: string | undefined;
    if (
      [
        ProcurementOrderStatus.PENDING_FINANCE_APPROVAL,
        ProcurementOrderStatus.FINANCE_APPROVED,
        ProcurementOrderStatus.ORDERED,
      ].includes(status)
    ) {
      const financeUrl = requireFinanceUrl();
      const res = await fetch(
        `${financeUrl}/api/transfer/external/cancel-by-ref`,
        {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': requireInternalSecret(),
          },
          body: JSON.stringify({
            externalRef: `warehouse_procurement:${id}`,
            reason: `Գնման պատվեր #${id} չեղարկվել է${reason ? `՝ ${reason}` : ''}`,
          }),
        },
      );
      if (!res.ok) {
        throw new BadRequestException(
          `Ֆինանսական գործարքը չհաջողվեց չեղարկել (finance-api ${res.status})`,
        );
      }
      const voided = (await res.json()) as {
        cancelled: number[];
        skippedCompleted: number[];
      };
      if (voided.skippedCompleted?.length) {
        financeNote =
          'Ուշադրություն. գործարք(ներ)ը արդեն կատարված են ֆինանսում — գումարի վերադարձը պետք է լուծվի առանձին';
      }
    }

    const cancelled = await this.prisma.procurementOrder.update({
      where: { id },
      data: { status: ProcurementOrderStatus.CANCELLED },
      include,
    });

    void this.notifications.send({
      permissions: ['receive_procurement_alerts', 'manage_warehouse'],
      title: 'Գնման պատվերը չեղարկվել է',
      body: `Գնման պատվեր #${id} չեղարկվել է${reason ? `՝ ${reason}` : ''}։`,
      path: '/procurement',
      details: [
        { label: 'Պատվեր', value: `#${id}` },
        ...(order.supplier?.name
          ? [{ label: 'Մատակարար', value: order.supplier.name }]
          : []),
        ...(financeNote ? [{ label: 'Ֆինանս', value: financeNote }] : []),
      ],
    });

    return financeNote ? { ...cancelled, financeNote } : cancelled;
  }

  /**
   * Settle an order at less than the ordered quantity — the rest is not coming.
   * Without this, partially delivered orders would sit outstanding forever.
   * Creates no stock: only what actually arrived was ever added.
   */
  async closeShort(id: number, reason?: string) {
    const order = await this.findOne(id);
    if (
      ![
        ProcurementOrderStatus.PARTIALLY_RECEIVED,
        ProcurementOrderStatus.ORDERED,
        ProcurementOrderStatus.FINANCE_APPROVED,
      ].includes(order.status as ProcurementOrderStatus)
    ) {
      throw new BadRequestException(
        `An order with status ${order.status} cannot be closed short`,
      );
    }

    const shortfallValue = order.items.reduce(
      (sum, l) =>
        sum + (l.quantity - (l.receivedQuantity ?? 0)) * (l.unitPrice ?? 0),
      0,
    );
    const shortLines = order.items.filter(
      (l) => (l.receivedQuantity ?? 0) < l.quantity - 1e-9,
    );

    const closed = await this.prisma.procurementOrder.update({
      where: { id },
      data: {
        status: ProcurementOrderStatus.CLOSED_SHORT,
        closedShortAt: new Date(),
        closedShortReason: reason,
      },
      include,
    });

    // Pay only for what arrived — the authorized amount covered the full order.
    await this.reconcileWithFinance(
      order,
      this.invoicedValue(order.items),
      `Պատվերը փակվել է թերի${reason ? `՝ ${reason}` : ''}`,
    );

    // Finance was billed on the ordered quantity, so a short close means money
    // out for goods that never arrived. Surface it rather than adjusting
    // anything automatically — recovering it is a human negotiation.
    void this.notifications.send({
      permissions: ['receive_procurement_alerts', 'manage_warehouse'],
      title: 'Գնման պատվերը փակվել է թերի',
      // The amount belongs in the body, not only in `details`: details render
      // in the email, and email is off unless EMAIL_USER/EMAIL_PASS are set —
      // the shortfall is the whole point of this alert.
      body:
        `Գնման պատվեր #${id} փակվել է չմատակարարված մնացորդով՝ ` +
        `${Math.round(shortfallValue).toLocaleString('hy-AM')} ֏ արժեքի ${shortLines.length} տող։`,
      path: '/procurement',
      details: [
        { label: 'Պատվեր', value: `#${id}` },
        ...(order.supplier?.name
          ? [{ label: 'Մատակարար', value: order.supplier.name }]
          : []),
        { label: 'Չմատակարարված տողեր', value: String(shortLines.length) },
        {
          label: 'Չմատակարարված գումար',
          value: `${Math.round(shortfallValue).toLocaleString('hy-AM')} ֏`,
        },
        ...(reason ? [{ label: 'Պատճառ', value: reason }] : []),
      ],
    });

    return closed;
  }

  /**
   * Raise the money again after finance refused it.
   *
   * This is the ONE place a procurement order becomes a new financial attempt,
   * which is why the counter lives here and not in `finalize`. Finance's
   * refusal is history: the rejected transfers stay exactly as they are, and
   * the next finalize writes new rows under the same `externalRef` with new
   * operation keys. Bumping the counter is what makes those rows possible —
   * without it the resubmission would collide with the attempt finance already
   * turned down.
   */
  async resubmit(id: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.FINANCE_REJECTED) {
      throw new BadRequestException(
        'Only FINANCE_REJECTED orders can be resubmitted',
      );
    }
    return this.prisma.procurementOrder.update({
      where: { id },
      // Back to a draft, so the previous rejection reason no longer describes
      // it — leaving it would attach finance's old objection to a fresh order.
      data: {
        status: ProcurementOrderStatus.DRAFT,
        financeRejectionReason: null,
        financeAttempt: { increment: 1 },
      },
      include,
    });
  }

  /** The order's sum and deposit, refused when the deposit exceeds the sum. */
  private payable(order: { items: { quantity: number; unitPrice: number | null }[]; prepaymentAmount: number | null }) {
    const total = order.items.reduce(
      (sum, i) => sum + i.quantity * (i.unitPrice ?? 0),
      0,
    );
    const prepayment = order.prepaymentAmount ?? 0;
    if (prepayment > total) {
      throw new BadRequestException(
        `Կանխավճարը (${prepayment}) չի կարող գերազանցել պատվերի արժեքը (${total})`,
      );
    }
    return { total, prepayment };
  }

  /**
   * Step one (2026-09-25): procurement sends the draft for approval. Nothing
   * reaches finance yet — approve() does that once a holder of
   * approve_purchase_order in the order's organization says yes.
   */
  async finalize(id: number, userId?: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.DRAFT) {
      throw new BadRequestException(
        'Միայն նախագիծ պատվերները կարող են ուղարկվել հաստատման',
      );
    }
    this.payable(order as any);
    return this.prisma.procurementOrder.update({
      where: { id },
      data: {
        status: ProcurementOrderStatus.PENDING_APPROVAL,
        submittedForApprovalBy: userId ?? null,
        submittedForApprovalAt: new Date(),
        approvalRejectedBy: null,
        approvalRejectedAt: null,
        approvalRejectionReason: null,
      },
      include,
    });
  }

  private async assertMayApprove(order: { entityId: number | null }, userId: number) {
    // Held in the order's organization; an order without one needs the right anywhere.
    const info = await this.usersPrisma.getUserAccessInfo(userId, order.entityId ?? undefined);
    if (!info.isSuperAdmin && !info.permissionNames.includes(APPROVE_ORDER_PERMISSION)) {
      throw new ForbiddenException('Դուք այս կազմակերպության գնման պատվերները հաստատելու թույլտվություն չունեք');
    }
  }

  /** Step two: the approver says yes — the money is raised with finance and the order waits for finance's word. */
  async approve(id: number, userId: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Պատվերը հաստատման սպասման մեջ չէ');
    }
    await this.assertMayApprove(order as any, userId);
    await this.prisma.procurementOrder.update({
      where: { id },
      data: { approvedBy: userId, approvedAt: new Date() },
    });
    return this.sendToFinance(id);
  }

  /** The approver says no — back to draft with the reason, the way a finance rejection returns it. */
  async rejectApproval(id: number, userId: number, reason?: string) {
    if (!reason?.trim()) throw new BadRequestException('Մերժման պատճառը պարտադիր է');
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Պատվերը հաստատման սպասման մեջ չէ');
    }
    await this.assertMayApprove(order as any, userId);
    return this.prisma.procurementOrder.update({
      where: { id },
      data: {
        status: ProcurementOrderStatus.DRAFT,
        approvalRejectedBy: userId,
        approvalRejectedAt: new Date(),
        approvalRejectionReason: reason.trim(),
      },
      include,
    });
  }

  /** Raises the order's money with finance (deposit first, then the balance) and moves it to finance approval. */
  private async sendToFinance(id: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.PENDING_APPROVAL) {
      throw new BadRequestException('Պատվերը հաստատման սպասման մեջ չէ');
    }
    const { total, prepayment } = this.payable(order as any);

    const financeUrl = requireFinanceUrl();
    // Was `process.env.INTERNAL_SECRET || ''`, which sent a blank credential
    // from an unconfigured service — and logged the secret's length next to it.
    // Neither belongs on a route that creates money.
    const internalKey = requireInternalSecret();
    console.log(
      `[procurement:finalize] calling finance-api: POST ${financeUrl}/api/transfer/external`,
    );

    const supplierSuffix = order.supplier ? ` — ${order.supplier.name}` : '';

    /**
     * Raise one transfer in finance. The prepayment carries a `:prepayment`
     * suffix on the ref so finance can tell the two apart without a lookup —
     * everything that parses the ref reads the id from `split(':')[1]`, which
     * is unchanged.
     *
     * The ref says which order; the operation key says which send. That is
     * what makes the retry described below safe: the comment under it used to
     * admit that retrying a half-failed finalize "would duplicate it" and
     * offer, as consolation, that somebody would probably spot the duplicate
     * in the approval queue. Now the deposit that already exists comes back
     * instead of being raised twice.
     */
    const raise = async (
      amount: number,
      kind: 'FULL' | 'PREPAYMENT' | 'BALANCE',
      label: string,
    ): Promise<number> => {
      const res = await fetch(`${financeUrl}/api/transfer/external`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': internalKey,
        },
        body: JSON.stringify({
          amount,
          // The organization the purchase was made for, so finance reports the
          // spend against it rather than against nothing.
          entityId: (order as any).entityId ?? undefined,
          description: `${label} #${id}${supplierSuffix}`,
          externalRef:
            kind === 'PREPAYMENT'
              ? `warehouse_procurement:${id}:prepayment`
              : `warehouse_procurement:${id}`,
          operationKey: transferOperationKey(
            'warehouse_procurement',
            id,
            kind,
            order.financeAttempt,
          ),
          paymentKind: kind,
          // Deliberately no date — see maintenance.finalize for why the send
          // time must not become part of the operation's identity.
        }),
      });
      const body = await res.text();
      console.log(
        `[procurement:finalize] finance-api response (${kind}): status=${res.status} body=${body}`,
      );
      if (!res.ok) {
        throw new Error(
          `finance-api ${res.status} (url: ${financeUrl}): ${body}`,
        );
      }
      return JSON.parse(body).id;
    };

    let prepaymentTransferId: number | undefined;
    let balanceTransferId: number | undefined;
    try {
      if (prepayment > 0) {
        // The deposit first: if the balance call then fails the order stays in
        // DRAFT and finalize can be retried. That retry used to duplicate the
        // deposit, and the defence was that somebody would notice it in the
        // approval queue. It now carries the same operation key and finance
        // hands back the row it already created.
        prepaymentTransferId = await raise(
          prepayment,
          'PREPAYMENT',
          'Կանխավճար — գնման պատվեր',
        );
        // A fully prepaid order has nothing left to bill. Raising a zero
        // transfer would put a meaningless row in the approval queue for
        // someone to action.
        if (total - prepayment > 0.005) {
          balanceTransferId = await raise(
            total - prepayment,
            'BALANCE',
            'Մնացորդ — գնման պատվեր',
          );
        }
      } else {
        balanceTransferId = await raise(total, 'FULL', 'Գնման պատվեր');
      }
    } catch (e: any) {
      const financeError = e?.message?.startsWith('finance-api')
        ? e.message
        : `network error reaching ${financeUrl}: ${e?.message ?? e}`;
      console.error(`[procurement:finalize] ${financeError}`);
      throw new BadRequestException(
        `Finance notification failed — ${financeError}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // The order keeps pointing at the BALANCE transfer: that is the one whose
      // amount is corrected when the order closes, so every existing path that
      // reads financeTransferId keeps working unchanged.
      const updated = await tx.procurementOrder.update({
        where: { id },
        data: {
          status: ProcurementOrderStatus.PENDING_FINANCE_APPROVAL,
          ...(balanceTransferId
            ? { financeTransferId: balanceTransferId }
            : {}),
        },
        include,
      });

      if (prepaymentTransferId) {
        await tx.procurementPayment.create({
          data: {
            orderId: id,
            type: 'PREPAYMENT',
            amount: prepayment,
            financeTransferId: prepaymentTransferId,
            status: 'PENDING',
          },
        });
      }
      if (balanceTransferId) {
        await tx.procurementPayment.create({
          data: {
            orderId: id,
            type: 'BALANCE',
            amount: total - prepayment,
            financeTransferId: balanceTransferId,
            status: 'PENDING',
          },
        });
      }
      return updated;
    });
  }

  /**
   * Called by finance when a transfer is approved or rejected.
   *
   * Idempotent on purpose: if the order is already in the state being asked
   * for, report success instead of failing. Finance treats a non-2xx here as a
   * hard error and rolls its own approval back, so a strict check turned any
   * retry into a permanent deadlock — warehouse had already moved on, finance
   * had rolled back, and every subsequent attempt hit the same 400.
   */
  async financeCallback(
    id: number,
    status: 'APPROVED' | 'REJECTED',
    rejectionReason?: string,
    transferId?: number,
  ) {
    const order = await this.findOne(id);
    // Finance names the transfer it decided on. A payment row that carries it
    // takes the verdict; a price correction ends there — the order's own
    // status has nothing to do with it any more.
    if (transferId) {
      const payment = await this.prisma.procurementPayment.findFirst({
        where: { orderId: id, financeTransferId: transferId },
      });
      if (payment) {
        await this.prisma.procurementPayment.update({
          where: { id: payment.id },
          data: { status },
        });
        if (payment.type === 'ADJUSTMENT' || payment.type === 'REFUND')
          return this.findOne(id);
      }
    }
    const target =
      status === 'APPROVED'
        ? ProcurementOrderStatus.FINANCE_APPROVED
        : ProcurementOrderStatus.FINANCE_REJECTED;

    if (order.status === target) {
      this.logger.log(
        `Order #${id} is already ${target} — finance callback treated as a no-op`,
      );
      return order;
    }
    if (order.status !== ProcurementOrderStatus.PENDING_FINANCE_APPROVAL) {
      throw new BadRequestException(
        `Order #${id} is ${order.status}, not awaiting finance approval`,
      );
    }
    return this.prisma.procurementOrder.update({
      where: { id },
      data: {
        status:
          status === 'APPROVED'
            ? ProcurementOrderStatus.FINANCE_APPROVED
            : ProcurementOrderStatus.FINANCE_REJECTED,
        // Cleared on approval, so an order rejected once and approved on the
        // second pass does not keep showing the old reason.
        financeRejectionReason:
          status === 'REJECTED' ? (rejectionReason ?? null) : null,
      },
      include,
    });
  }

  async remove(id: number) {
    const order = await this.findOne(id);
    if (order.status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Ստացված պատվերը հնարավոր չէ ջնջել');
    }
    return this.prisma.procurementOrder.delete({ where: { id } });
  }
}
