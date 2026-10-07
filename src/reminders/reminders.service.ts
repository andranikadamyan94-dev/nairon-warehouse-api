import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from 'prisma/prisma.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from '../common/notifications/notifications.service';
import { ReservationsService } from '../reservations/reservations.service';
import { ObjectsService } from '../objects/objects.service';

/** Asia/Yerevan has no DST: UTC+4 all year. */
const YEREVAN = '+04:00';
const DAY_MS = 24 * 60 * 60 * 1000;
/** An overdue record is reminded of for at most this many days (owner, 2026-10-07). */
export const OVERDUE_DAYS = 7;
/** An issued asset counts as unconfirmed after this many days. */
export const RECEIPT_GRACE_DAYS = 2;

export const REMINDER_KIND = {
  maintenance: 'maintenance_due',
  dueBack: 'asset_due_back',
  receipt: 'receipt_unconfirmed',
} as const;

/** Maintenance still open — neither done nor refused by finance. */
const OPEN_MAINTENANCE = ['DRAFT', 'PENDING_FINANCE', 'FINANCE_APPROVED', 'IN_PROGRESS'];
/** Reservations whose goods may be out. */
const OUT_RESERVATION = ['APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED'];

/** The Yerevan calendar day of `now`, and the instants its days start at. */
export function yerevanDays(now: Date) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yerevan', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const todayStart = new Date(`${day}T00:00:00${YEREVAN}`);
  return {
    /** YYYY-MM-DD in Yerevan — the marker's day. */
    day,
    todayStart,
    tomorrowStart: new Date(todayStart.getTime() + DAY_MS),
    dayAfterStart: new Date(todayStart.getTime() + 2 * DAY_MS),
    /** The oldest overdue date still reminded of. */
    overdueFloor: new Date(todayStart.getTime() - OVERDUE_DAYS * DAY_MS),
  };
}

const fmt = (d: Date | null | undefined) =>
  d ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yerevan' }).format(d) : '—';

/**
 * The warehouse's first scheduled job (notifications phase 3, 2026-10-07):
 * one run a day at 09:00 Asia/Yerevan.
 *
 *   maintenance_due     a maintenance job starts tomorrow, or its end date
 *                       has passed (at most 7 days) and it is still open →
 *                       the asset's holder + manage_maintenance /
 *                       manage_warehouse in the item's organisation;
 *   asset_due_back      a reservation with an asset still out ends tomorrow,
 *                       or ended (at most 7 days ago) → the requesting side:
 *                       the task's assignees, the object's responsible
 *                       person, the catalog requester;
 *   receipt_unconfirmed an asset handed over at least 2 days ago (at most 7
 *                       days of reminding) and not confirmed as received →
 *                       the holder (an object: its responsible person), the
 *                       issuer copied.
 *
 * Idempotent per record per day: a WarehouseReminderMarker row (kind, record,
 * Yerevan day) is claimed before anything is sent; a claim that already
 * exists means somebody (a restart, another replica) already sent it.
 * Never throws — a failing reminder must not stop the others.
 */
@Injectable()
export class WarehouseRemindersService {
  private readonly logger = new Logger(WarehouseRemindersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: WarehouseNotificationsService,
    private readonly reservations: ReservationsService,
    @Optional() private readonly objects?: ObjectsService,
  ) {}

  @Cron('0 9 * * *', { name: 'warehouse-daily-reminders', timeZone: 'Asia/Yerevan' })
  async daily(): Promise<void> {
    if (process.env.WAREHOUSE_REMINDERS_DISABLED === 'true') return;
    await this.run(new Date());
  }

  /** One run, for `now`. Public for tests and for a manual re-run. */
  async run(now: Date): Promise<{ maintenance: number; dueBack: number; receipts: number }> {
    const days = yerevanDays(now);
    const result = { maintenance: 0, dueBack: 0, receipts: 0 };
    for (const [key, step] of [
      ['maintenance', () => this.maintenanceDue(days)],
      ['dueBack', () => this.assetsDueBack(days)],
      ['receipts', () => this.receiptsUnconfirmed(days, now)],
    ] as const) {
      try {
        result[key] = await step();
      } catch (e: any) {
        this.logger.error(`daily reminders (${key}) failed: ${e?.message ?? e}`);
      }
    }
    this.logger.log(`daily reminders ${days.day}: ${JSON.stringify(result)}`);
    return result;
  }

  /** Claim (kind, record, day). True = ours to send; false = already sent today. */
  async claim(kind: string, refId: number, day: string): Promise<boolean> {
    const { count } = await this.prisma.warehouseReminderMarker.createMany({
      data: [{ kind, refId, day: new Date(`${day}T00:00:00Z`) }],
      skipDuplicates: true,
    });
    return count > 0;
  }

  private async entityOfItem(categoryId: number | null | undefined): Promise<number | null> {
    if (!categoryId) return null;
    const c = await this.prisma.itemCategory.findUnique({ where: { id: categoryId }, select: { entityId: true } }).catch(() => null);
    return c?.entityId ?? null;
  }

  /** The person (or the object's responsible person) holding an asset now. */
  private async holderOf(custody: { holderUserId: number | null; holderObjectId: number | null } | undefined, fallback: number | null) {
    if (custody?.holderUserId) return { userId: custody.holderUserId, path: '/profile?tab=assets' };
    if (custody?.holderObjectId && this.objects) {
      const o = await this.objects.crmObject(custody.holderObjectId).catch(() => null);
      if (o?.responsibleId) return { userId: o.responsibleId as number, path: `/objects/${custody.holderObjectId}` };
    }
    return fallback ? { userId: fallback, path: '/profile?tab=assets' } : null;
  }

  async maintenanceDue(days: ReturnType<typeof yerevanDays>): Promise<number> {
    const records = await this.prisma.maintenanceRecord.findMany({
      where: {
        status: { in: OPEN_MAINTENANCE as any },
        OR: [
          { startDate: { gte: days.tomorrowStart, lt: days.dayAfterStart } },
          { endDate: { lt: days.todayStart, gte: days.overdueFloor } },
        ],
      },
      include: {
        asset: { include: { item: true, custodies: { where: { releasedAt: null }, take: 1 } } },
      },
    });
    let sent = 0;
    for (const r of records) {
      try {
        if (!(await this.claim(REMINDER_KIND.maintenance, r.id, days.day))) continue;
        const starts = r.startDate >= days.tomorrowStart && r.startDate < days.dayAfterStart;
        const what = `${r.asset?.item?.name ?? 'Ակտիվ'}${r.asset?.serialNumber ? ` (${r.asset.serialNumber})` : ''}`;
        const holder = await this.holderOf(r.asset?.custodies?.[0], r.asset?.responsibleUserId ?? null);
        const title = starts ? 'Սպասարկումը սկսվում է վաղը' : 'Սպասարկման ժամկետն անցել է';
        const body = starts
          ? `${what}՝ սպասարկում #${r.id}-ը սկսվում է վաղը (${fmt(r.startDate)})։`
          : `${what}՝ սպասարկում #${r.id}-ի ավարտի ամսաթիվը (${fmt(r.endDate)}) անցել է, բայց այն դեռ բաց է։`;
        const details = [
          { label: 'Սպասարկում', value: `#${r.id}` },
          { label: 'Ակտիվ', value: what },
          { label: 'Սկիզբ', value: fmt(r.startDate) },
          { label: 'Ավարտ', value: fmt(r.endDate) },
        ];
        // The holder sees it on their own page; the desk on the maintenance page.
        if (holder) {
          await this.notifications.sendToUsers([holder.userId], { type: WAREHOUSE_TYPES.maintenanceDue, title, body, path: holder.path, details });
        }
        await this.notifications.send({
          type: WAREHOUSE_TYPES.maintenanceDue,
          permissions: ['manage_maintenance', 'manage_warehouse'],
          entityIds: [await this.entityOfItem(r.asset?.item?.categoryId)],
          excludeUserIds: holder ? [holder.userId] : [],
          title,
          body,
          path: '/maintenance',
          details,
        });
        sent++;
      } catch (e: any) {
        this.logger.warn(`maintenance reminder #${r.id} failed: ${e?.message ?? e}`);
      }
    }
    return sent;
  }

  async assetsDueBack(days: ReturnType<typeof yerevanDays>): Promise<number> {
    const rows = await this.prisma.resourceReservation.findMany({
      where: {
        status: { in: OUT_RESERVATION as any },
        item: { type: 'ASSET' },
        allocations: { some: { releasedAt: null, assetId: { not: null } } },
        OR: [
          { endDate: { gte: days.tomorrowStart, lt: days.dayAfterStart } },
          { endDate: { lt: days.todayStart, gte: days.overdueFloor } },
        ],
      },
      include: {
        item: true,
        allocations: { where: { releasedAt: null, assetId: { not: null } }, include: { asset: true } },
      },
    });
    let sent = 0;
    for (const r of rows) {
      try {
        if (!r.endDate) continue;
        const side = await this.reservations.requesterSide(r);
        if (!side.userIds.length) continue;
        if (!(await this.claim(REMINDER_KIND.dueBack, r.id, days.day))) continue;
        const tomorrow = r.endDate >= days.tomorrowStart;
        const serials = r.allocations.map((a) => a.asset?.serialNumber).filter(Boolean).join(', ');
        const what = `${r.item?.name ?? 'Ակտիվ'}${serials ? ` (${serials})` : ''}`;
        await this.notifications.sendToUsers(side.userIds, {
          type: WAREHOUSE_TYPES.assetDueBack,
          title: tomorrow ? 'Ակտիվը պետք է վերադարձվի վաղը' : 'Ակտիվի վերադարձի ժամկետն անցել է',
          body: tomorrow
            ? `${what}՝ ամրագրումն ավարտվում է վաղը (${fmt(r.endDate)})։ Պատրաստեք վերադարձը։`
            : `${what}՝ ամրագրումն ավարտվել է ${fmt(r.endDate)}-ին, ակտիվը դեռ վերադարձված չէ։`,
          path: side.path,
          details: [
            { label: 'Ամրագրում', value: `#${r.id}` },
            { label: 'Ակտիվ', value: what },
            { label: 'Ավարտ', value: fmt(r.endDate) },
            ...(side.label ? [{ label: side.kind === 'task' ? 'Առաջադրանք' : side.kind === 'object' ? 'Օբյեկտ' : 'Հարցում', value: side.label }] : []),
          ],
        });
        sent++;
      } catch (e: any) {
        this.logger.warn(`due-back reminder #${r.id} failed: ${e?.message ?? e}`);
      }
    }
    return sent;
  }

  async receiptsUnconfirmed(days: ReturnType<typeof yerevanDays>, now: Date): Promise<number> {
    const latest = new Date(now.getTime() - RECEIPT_GRACE_DAYS * DAY_MS);
    const earliest = new Date(latest.getTime() - OVERDUE_DAYS * DAY_MS);
    const rows = await this.prisma.assetCustody.findMany({
      where: { releasedAt: null, acceptedAt: null, assignedAt: { lte: latest, gte: earliest } },
      include: { asset: { include: { item: true } } },
    });
    let sent = 0;
    for (const c of rows) {
      try {
        const holder = await this.holderOf(c, null);
        if (!holder && !c.assignedBy) continue;
        if (!(await this.claim(REMINDER_KIND.receipt, c.id, days.day))) continue;
        const what = `${c.asset?.item?.name ?? 'Գույք'}${c.asset?.serialNumber ? ` (${c.asset.serialNumber})` : ''}`;
        const details = [
          { label: 'Գույք', value: what },
          { label: 'Տրամադրվել է', value: fmt(c.assignedAt) },
        ];
        if (holder) {
          await this.notifications.sendToUsers([holder.userId], {
            type: WAREHOUSE_TYPES.receiptUnconfirmed,
            title: 'Հաստատեք գույքի ստացումը',
            body: `${what}՝ տրամադրվել է ${fmt(c.assignedAt)}-ին, ստացումը դեռ հաստատված չէ։`,
            path: holder.path,
            details,
          });
        }
        if (c.assignedBy && c.assignedBy !== holder?.userId) {
          await this.notifications.sendToUsers([c.assignedBy], {
            type: WAREHOUSE_TYPES.receiptUnconfirmed,
            title: 'Գույքի ստացումը չի հաստատվել',
            body: `${what}՝ ձեր տրամադրած գույքի ստացումը ${RECEIPT_GRACE_DAYS} օրից ավելի է չի հաստատվել։`,
            path: '/responsibilities',
            details,
          });
        }
        sent++;
      } catch (e: any) {
        this.logger.warn(`receipt reminder #${c.id} failed: ${e?.message ?? e}`);
      }
    }
    return sent;
  }
}
