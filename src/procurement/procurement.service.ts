import {
  BadRequestException,
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

const include = {
  supplier: true,
  items: { include: { item: true } },
  // Delivery history — an order can arrive in instalments, each with its own
  // receipt document.
  deliveries: {
    orderBy: { receivedAt: 'desc' as const },
    include: { items: true },
  },
};

@Injectable()
export class ProcurementService {
  private readonly logger = new Logger(ProcurementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
    private readonly stockAlerts: StockAlertService,
    private readonly notifications: WarehouseNotificationsService,
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
        : [{ createdAt: query?.sortBy === 'createdAt' ? order : 'desc' }, { id: 'desc' }];

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

  async create(dto: CreateProcurementDto) {
    return this.prisma.procurementOrder.create({
      data: {
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

  async update(id: number, dto: UpdateProcurementDto) {
    const order = await this.findOne(id);
    if (order.status === ProcurementOrderStatus.RECEIVED) {
      throw new BadRequestException('Ստացված պատվերը հնարավոր չէ խմբագրել');
    }

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
      throw new BadRequestException('Պատվերը փակված է թերի — այլևս հնարավոր չէ ընդունել');
    }
    if (order.status === ProcurementOrderStatus.CANCELLED) {
      throw new BadRequestException('Պատվերը չեղարկված է');
    }
    if (order.status === ProcurementOrderStatus.PENDING_FINANCE_APPROVAL) {
      throw new BadRequestException('Պատվերը սպասում է ֆինանսական հաստատման');
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
    if (!receiptFile) {
      throw new BadRequestException(
        'Մատակարարումը գրանցելու համար պարտադիր է կցել փաստաթուղթ',
      );
    }

    const remaining = (line: { quantity: number; receivedQuantity: number }) =>
      line.quantity - (line.receivedQuantity ?? 0);

    // No explicit lines → deliver everything still outstanding.
    const requested = dto?.lines?.length
      ? dto.lines
      : order.items
          .filter((l) => remaining(l) > 0)
          .map((l) => ({ orderItemId: l.id, quantity: remaining(l) }));

    if (!requested.length) {
      throw new BadRequestException('Այս պատվերով մնացորդ չկա');
    }

    // Validate before touching anything — a delivery is all-or-nothing.
    const byId = new Map(order.items.map((l) => [l.id, l]));
    const planned: { line: (typeof order.items)[number]; quantity: number }[] = [];
    for (const entry of requested) {
      const line = byId.get(entry.orderItemId);
      if (!line) {
        throw new BadRequestException(`Line ${entry.orderItemId} is not on order #${id}`);
      }
      if (entry.quantity <= 0) {
        throw new BadRequestException(`Delivered quantity must be greater than 0`);
      }
      // Over-delivery is rejected: silently absorbing extra stock would break
      // reconciliation against what finance was billed.
      if (entry.quantity > remaining(line) + 1e-9) {
        throw new BadRequestException(
          `Cannot receive ${entry.quantity} of "${line.item.name}" — only ${remaining(line)} outstanding`,
        );
      }
      planned.push({ line, quantity: entry.quantity });
    }

    const receiptUrl = this.fileService.upload(receiptFile);
    const isFirstDelivery = !order.receivedAt;

    // Large asset orders (bulk createMany) need more than the 5s default
    const result = await this.prisma.$transaction(
      async (tx) => {
        const delivery = await tx.procurementDelivery.create({
          data: {
            orderId: id,
            receiptUrl,
            notes: dto?.notes,
            receivedBy,
          },
        });

        for (const { line, quantity } of planned) {
          await tx.procurementDeliveryItem.create({
            data: { deliveryId: delivery.id, orderItemId: line.id, quantity },
          });

          if (line.item.type === 'ASSET') {
            // One bulk insert — creating rows one-by-one blew the transaction
            // timeout on large orders (e.g. 100k units → 100k round trips).
            // Counts the DELIVERED quantity, not the ordered one.
            const count = Math.round(quantity);
            if (count > 0) {
              await tx.asset.createMany({
                data: Array.from({ length: count }, () => ({ itemId: line.itemId })),
              });
            }
          } else {
            await tx.item.update({
              where: { id: line.itemId },
              data: { quantity: { increment: quantity } },
            });
          }

          await tx.procurementOrderItem.update({
            where: { id: line.id },
            data: { receivedQuantity: { increment: quantity } },
          });

          await tx.inventoryMovement.create({
            data: {
              itemId: line.itemId,
              quantity,
              type: 'IN',
              supplierId: order.supplierId ?? undefined,
              notes: `Procurement order #${id}, delivery #${delivery.id}`,
            },
          });
        }

        // Complete only when every line is fully satisfied.
        const lines = await tx.procurementOrderItem.findMany({ where: { orderId: id } });
        const complete = lines.every((l) => l.receivedQuantity >= l.quantity - 1e-9);

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
      planned.filter((p) => p.line.item.type !== 'ASSET').map((p) => p.line.itemId),
    );

    const complete = result.status === ProcurementOrderStatus.RECEIVED;

    // On completion, reconcile finance against what actually arrived. Normally
    // that equals the ordered value and settleWithFinance is a no-op; it only
    // does work if quantities ended up differing.
    if (complete) {
      await this.settleWithFinance(
        result,
        this.deliveredValue(result.items),
        'Պատվերն ամբողջությամբ ստացվել է',
      );
    }
    void this.notifications.send({
      permissions: ['receive_procurement_alerts', 'manage_warehouse'],
      title: complete ? 'Գնման պատվերը ստացվել է' : 'Գնման պատվերը ստացվել է մասնակի',
      body: complete
        ? `Գնման պատվեր #${id} ամբողջությամբ ստացվել է և պաշարը թարմացվել է։`
        : `Գնման պատվեր #${id}-ի մի մասը ստացվել է։ Մնացած քանակը դեռ սպասվում է։`,
      path: '/procurement',
      details: [
        { label: 'Պատվեր', value: `#${id}` },
        ...(order.supplier?.name ? [{ label: 'Մատակարար', value: order.supplier.name }] : []),
        { label: 'Ստացված այս անգամ', value: String(planned.length) },
        ...(complete ? [] : [{ label: 'Կարգավիճակ', value: 'Մասնակի ստացված' }]),
      ],
    });

    return result;
  }

  /**
   * Bill finance for what actually arrived.
   *
   * The order is authorized at the ordered value when it's finalized, which in
   * finance terms is a PENDING transfer that finance approves (APPROVED =
   * planned, not yet booked as expense). Settling corrects that amount to the
   * delivered value before finance books it, so a short delivery is simply
   * never paid for — no credit note, nothing to chase.
   *
   * Best-effort and never throws: failing to adjust must not block closing the
   * order. If finance already booked the transfer the adjustment is refused,
   * and that discrepancy is surfaced to a human rather than silently rewritten.
   */
  private async settleWithFinance(order: any, deliveredValue: number, reason: string) {
    const transferId = order.financeTransferId;

    const orderedValue = order.items.reduce(
      (sum: number, l: any) => sum + l.quantity * (l.unitPrice ?? 0),
      0,
    );

    // A deposit has already been paid, so the balance transfer only ever covers
    // what is still owed. Clamped at zero: a delivery worth less than the
    // deposit means the supplier owes us money, which is a refund to chase —
    // never a negative expense.
    const prepaid = order.prepaymentAmount ?? 0;
    const balanceDue = Math.max(0, deliveredValue - prepaid);
    const balanceAuthorized = Math.max(0, orderedValue - prepaid);

    if (prepaid > 0 && deliveredValue < prepaid - 0.005) {
      void this.notifications.send({
        permissions: ['receive_procurement_alerts', 'manage_warehouse'],
        title: 'Կանխավճարը գերազանցում է ստացվածը',
        body:
          `Պատվեր #${order.id}: կանխավճար ${prepaid}, ստացվել է ${deliveredValue}-ի չափով։ ` +
          `Մատակարարը պարտք է ${Math.round((prepaid - deliveredValue) * 100) / 100}։ Պահանջեք վերադարձ։`,
      });
    }

    // Checked after the overpayment alert above, not before: a fully prepaid
    // order has no balance transfer at all, and that is exactly the case where
    // the supplier is most likely to owe money back.
    if (!transferId) return;
    if (Math.abs(balanceAuthorized - balanceDue) < 0.005) return; // nothing to correct

    const financeUrl = process.env.FINANCE_API_URL || 'http://localhost:3005';
    try {
      const res = await fetch(`${financeUrl}/api/transfer/external/${transferId}/amount`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'x-internal-secret': process.env.INTERNAL_SECRET || '',
        },
        body: JSON.stringify({ amount: balanceDue, reason }),
      });

      if (res.ok) {
        // finalize already wrote a BALANCE row for this transfer; correct it
        // rather than stacking a second row for the same payment.
        const existing = await this.prisma.procurementPayment.findFirst({
          where: { orderId: order.id, financeTransferId: transferId, type: 'BALANCE' },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.procurementPayment.update({
            where: { id: existing.id },
            data: { amount: balanceDue, status: 'ADJUSTED' },
          });
        } else {
          await this.prisma.procurementPayment.create({
            data: {
              orderId: order.id,
              type: 'BALANCE',
              amount: balanceDue,
              financeTransferId: transferId,
              status: 'ADJUSTED',
            },
          });
        }
        this.logger.log(
          `Order #${order.id}: finance transfer ${transferId} corrected ${balanceAuthorized} → ${balanceDue} (prepaid ${prepaid})`,
        );
        return;
      }

      // 409 = already booked. Anything else is a genuine failure; both need a person.
      const detail = await res.text().catch(() => '');
      this.logger.error(
        `Order #${order.id}: could not correct finance transfer ${transferId} (${res.status}) ${detail}`,
      );
      void this.notifications.send({
        permissions: ['receive_procurement_alerts', 'manage_warehouse'],
        title: 'Ֆինանսական գումարը չհամապատասխանեց',
        body:
          `Գնման պատվեր #${order.id}-ի գումարը չհաջողվեց ճշգրտել։ ` +
          `Հաստատվել է ${Math.round(orderedValue).toLocaleString('hy-AM')} ֏, ` +
          `փաստացի ստացվել է ${Math.round(deliveredValue).toLocaleString('hy-AM')} ֏ արժեքով։ ` +
          `Անհրաժեշտ է ձեռքով ճշգրտում ֆինանսների հետ։`,
        path: '/procurement',
        details: [
          { label: 'Պատվեր', value: `#${order.id}` },
          { label: 'Ֆինանսական փոխանցում', value: `#${transferId}` },
        ],
      });
    } catch (e: any) {
      this.logger.error(`Order #${order.id}: finance adjust error — ${e?.message ?? e}`);
    }
  }

  /** Value of what has actually been received on an order. */
  private deliveredValue(items: any[]): number {
    return items.reduce((sum, l) => sum + (l.receivedQuantity ?? 0) * (l.unitPrice ?? 0), 0);
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
      (sum, l) => sum + (l.quantity - (l.receivedQuantity ?? 0)) * (l.unitPrice ?? 0),
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
    await this.settleWithFinance(
      order,
      this.deliveredValue(order.items),
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
        ...(order.supplier?.name ? [{ label: 'Մատակարար', value: order.supplier.name }] : []),
        { label: 'Չմատակարարված տողեր', value: String(shortLines.length) },
        { label: 'Չմատակարարված գումար', value: `${Math.round(shortfallValue).toLocaleString('hy-AM')} ֏` },
        ...(reason ? [{ label: 'Պատճառ', value: reason }] : []),
      ],
    });

    return closed;
  }

  async resubmit(id: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.FINANCE_REJECTED) {
      throw new BadRequestException(
        'Only FINANCE_REJECTED orders can be resubmitted',
      );
    }
    return this.prisma.procurementOrder.update({
      where: { id },
      data: { status: ProcurementOrderStatus.DRAFT },
      include,
    });
  }

  async finalize(id: number) {
    const order = await this.findOne(id);
    if (order.status !== ProcurementOrderStatus.DRAFT) {
      throw new BadRequestException('Միայն նախագիծ պատվերները կարող են ուղարկվել հաստատման');
    }

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

    const financeUrl = process.env.FINANCE_API_URL || 'http://localhost:3005';
    const internalKey = process.env.INTERNAL_SECRET || '';
    console.log(
      `[procurement:finalize] calling finance-api: POST ${financeUrl}/api/transfer/external | key_set=${!!internalKey} | key_len=${internalKey.length}`,
    );

    const supplierSuffix = order.supplier ? ` — ${order.supplier.name}` : '';

    /**
     * Raise one transfer in finance. The prepayment carries a `:prepayment`
     * suffix on the ref so finance can tell the two apart without a lookup —
     * everything that parses the ref reads the id from `split(':')[1]`, which
     * is unchanged.
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
          description: `${label} #${id}${supplierSuffix}`,
          externalRef:
            kind === 'PREPAYMENT'
              ? `warehouse_procurement:${id}:prepayment`
              : `warehouse_procurement:${id}`,
          paymentKind: kind,
          date: new Date().toISOString(),
        }),
      });
      const body = await res.text();
      console.log(
        `[procurement:finalize] finance-api response (${kind}): status=${res.status} body=${body}`,
      );
      if (!res.ok) {
        throw new Error(`finance-api ${res.status} (url: ${financeUrl}): ${body}`);
      }
      return JSON.parse(body).id;
    };

    let prepaymentTransferId: number | undefined;
    let balanceTransferId: number | undefined;
    try {
      if (prepayment > 0) {
        // The deposit first: if the balance call then fails the order stays in
        // DRAFT and finalize can be retried, which would duplicate it. The
        // duplicate is visible in the finance queue and rejectable, whereas an
        // order that can never be finalized is not.
        prepaymentTransferId = await raise(prepayment, 'PREPAYMENT', 'Կանխավճար — գնման պատվեր');
        // A fully prepaid order has nothing left to bill. Raising a zero
        // transfer would put a meaningless row in the approval queue for
        // someone to action.
        if (total - prepayment > 0.005) {
          balanceTransferId = await raise(total - prepayment, 'BALANCE', 'Մնացորդ — գնման պատվեր');
        }
      } else {
        balanceTransferId = await raise(total, 'FULL', 'Գնման պատվեր');
      }
    } catch (e: any) {
      const financeError =
        e?.message?.startsWith('finance-api')
          ? e.message
          : `network error reaching ${financeUrl}: ${e?.message ?? e}`;
      console.error(`[procurement:finalize] ${financeError}`);
      throw new BadRequestException(`Finance notification failed — ${financeError}`);
    }

    return this.prisma.$transaction(async (tx) => {
      // The order keeps pointing at the BALANCE transfer: that is the one whose
      // amount is corrected when the order closes, so every existing path that
      // reads financeTransferId keeps working unchanged.
      const updated = await tx.procurementOrder.update({
        where: { id },
        data: {
          status: ProcurementOrderStatus.PENDING_FINANCE_APPROVAL,
          ...(balanceTransferId ? { financeTransferId: balanceTransferId } : {}),
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
  async financeCallback(id: number, status: 'APPROVED' | 'REJECTED') {
    const order = await this.findOne(id);
    const target =
      status === 'APPROVED'
        ? ProcurementOrderStatus.FINANCE_APPROVED
        : ProcurementOrderStatus.FINANCE_REJECTED;

    if (order.status === target) {
      this.logger.log(`Order #${id} is already ${target} — finance callback treated as a no-op`);
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
