import { Injectable, Logger } from '@nestjs/common';
import { ItemType } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { WarehouseNotificationsService } from './notifications.service';

/** Holders of this get low-stock alerts; manage_warehouse holders do too. */
export const STOCK_ALERT_PERMISSIONS = ['receive_stock_alerts', 'manage_warehouse'];

/**
 * Fires a low-stock alert when an item's quantity crosses its minQuantity.
 *
 * "Crossing" is tracked with the `lowStockNotifiedAt` latch on Item rather than
 * by comparing before/after values: quantity is written from six different
 * paths (inventory movements, reservation approve/cancel, three allocation
 * routes, procurement receipt, returns), several of them via
 * increment/decrement inside a transaction where the previous value isn't
 * available. The latch makes the check idempotent, restart-safe, and correct no
 * matter which path did the write.
 *
 * ASSET items are ignored — their availability comes from individual Asset rows,
 * not this counter.
 */
@Injectable()
export class StockAlertService {
  private readonly logger = new Logger(StockAlertService.name);

  constructor(
    private prisma: PrismaService,
    private notifications: WarehouseNotificationsService,
  ) {}

  /**
   * Re-evaluate the given items and alert on any that just went low.
   *
   * Fire-and-forget: call AFTER the quantity write has committed, and do not
   * await inside a transaction. Never throws — a notification problem must not
   * fail the warehouse operation that triggered it.
   */
  check(itemIds: number[]): void {
    const ids = [...new Set(itemIds.filter((id) => Number.isFinite(id)))];
    if (!ids.length) return;
    void this.evaluate(ids).catch((e) =>
      this.logger.error(`Low-stock check failed for [${ids.join(', ')}]: ${e?.message ?? e}`),
    );
  }

  private async evaluate(ids: number[]): Promise<void> {
    const items = await this.prisma.item.findMany({
      where: { id: { in: ids }, type: ItemType.CONSUMABLE, minQuantity: { not: null } },
      select: {
        id: true,
        name: true,
        code: true,
        unit: true,
        quantity: true,
        minQuantity: true,
        lowStockNotifiedAt: true,
      },
    });

    for (const item of items) {
      const min = item.minQuantity as number;
      const isLow = (item.quantity ?? 0) <= min;

      // Recovered above the threshold — re-arm so the next breach alerts again.
      if (!isLow) {
        if (item.lowStockNotifiedAt) {
          await this.prisma.item.update({
            where: { id: item.id },
            data: { lowStockNotifiedAt: null },
          });
        }
        continue;
      }

      // Already alerted for this breach — stay quiet until stock recovers.
      if (item.lowStockNotifiedAt) continue;

      // Latch BEFORE sending so two concurrent writes can't both alert.
      const latched = await this.prisma.item.updateMany({
        where: { id: item.id, lowStockNotifiedAt: null },
        data: { lowStockNotifiedAt: new Date() },
      });
      if (latched.count === 0) continue;

      const unit = item.unit ? ` ${item.unit}` : '';
      await this.notifications.send({
        permissions: STOCK_ALERT_PERMISSIONS,
        title: 'Պաշարը սպառվում է',
        body: `«${item.name}» ապրանքի պաշարը հասել է նվազագույն սահմանին։`,
        path: '/',
        details: [
          { label: 'Ապրանք', value: item.name },
          ...(item.code ? [{ label: 'Կոդ', value: item.code }] : []),
          { label: 'Առկա քանակ', value: `${item.quantity}${unit}` },
          { label: 'Նվազագույն քանակ', value: `${min}${unit}` },
        ],
      });
      this.logger.log(`Low-stock alert sent for item ${item.id} (${item.quantity} <= ${min})`);
    }
  }
}
