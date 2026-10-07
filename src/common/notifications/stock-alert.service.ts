import { Injectable, Logger } from '@nestjs/common';
import { ItemType } from '@prisma/client';
import { PrismaService } from 'prisma/prisma.service';
import { WAREHOUSE_TYPES, WarehouseNotificationsService } from './notifications.service';

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
        // The stock's organisation: its category's (the audience is that organisation's holders).
        category: { select: { entityId: true } },
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
        type: WAREHOUSE_TYPES.lowStock,
        permissions: STOCK_ALERT_PERMISSIONS,
        entityIds: [item.category?.entityId ?? null],
        title: 'Պաշարը սպառվում է',
        // Phase 2: names the warehouse, links to the item (was "/").
        body: `«${item.name}» ապրանքի պաշարը հիմնական պահեստում հասել է նվազագույն սահմանին (${item.quantity}${unit})։`,
        path: itemPath(item.id),
        details: [
          { label: 'Ապրանք', value: item.name },
          ...(item.code ? [{ label: 'Կոդ', value: item.code }] : []),
          { label: 'Պահեստ', value: 'Հիմնական պահեստ' },
          { label: 'Առկա քանակ', value: `${item.quantity}${unit}` },
          { label: 'Նվազագույն քանակ', value: `${min}${unit}` },
        ],
      });
      this.logger.log(`Low-stock alert sent for item ${item.id} (${item.quantity} <= ${min})`);
    }
  }

  /**
   * The same check for a sub-warehouse's own pool (phase 2, 2026-10-06): the
   * item's minQuantity against WarehouseStock.quantity, latched per stock row
   * (WarehouseStock.lowStockNotifiedAt) the way Item's latch works for main.
   * The sub's responsible person is told; a sub without one falls back to the
   * stock-alert holders of the item's organisation. Fire-and-forget, never throws.
   */
  checkWarehouse(warehouseId: number | null | undefined, itemIds: number[]): void {
    if (!warehouseId) return;
    const ids = [...new Set(itemIds.filter((id) => Number.isFinite(id)))];
    if (!ids.length) return;
    void this.evaluateWarehouse(warehouseId, ids).catch((e) =>
      this.logger.error(`Low-stock check failed for warehouse ${warehouseId} [${ids.join(', ')}]: ${e?.message ?? e}`),
    );
  }

  private async evaluateWarehouse(warehouseId: number, ids: number[]): Promise<void> {
    const rows = await this.prisma.warehouseStock.findMany({
      where: { warehouseId, itemId: { in: ids }, item: { type: ItemType.CONSUMABLE, minQuantity: { not: null } } },
      select: {
        id: true,
        quantity: true,
        lowStockNotifiedAt: true,
        warehouse: { select: { name: true, responsibleId: true } },
        item: { select: { id: true, name: true, code: true, unit: true, minQuantity: true, category: { select: { entityId: true } } } },
      },
    });
    for (const row of rows) {
      const min = row.item.minQuantity as number;
      const isLow = (row.quantity ?? 0) <= min;
      if (!isLow) {
        if (row.lowStockNotifiedAt) {
          await this.prisma.warehouseStock.update({ where: { id: row.id }, data: { lowStockNotifiedAt: null } });
        }
        continue;
      }
      if (row.lowStockNotifiedAt) continue;
      const latched = await this.prisma.warehouseStock.updateMany({
        where: { id: row.id, lowStockNotifiedAt: null },
        data: { lowStockNotifiedAt: new Date() },
      });
      if (latched.count === 0) continue;

      const unit = row.item.unit ? ` ${row.item.unit}` : '';
      const n = {
        type: WAREHOUSE_TYPES.lowStock,
        title: 'Պաշարը սպառվում է',
        body: `«${row.item.name}» ապրանքի պաշարը «${row.warehouse.name}» պահեստում հասել է նվազագույն սահմանին (${row.quantity}${unit})։`,
        path: itemPath(row.item.id),
        details: [
          { label: 'Ապրանք', value: row.item.name },
          ...(row.item.code ? [{ label: 'Կոդ', value: row.item.code }] : []),
          { label: 'Պահեստ', value: row.warehouse.name },
          { label: 'Առկա քանակ', value: `${row.quantity}${unit}` },
          { label: 'Նվազագույն քանակ', value: `${min}${unit}` },
        ],
      };
      if (row.warehouse.responsibleId) await this.notifications.sendToUsers([row.warehouse.responsibleId], n);
      else await this.notifications.send({ ...n, permissions: STOCK_ALERT_PERMISSIONS, entityIds: [row.item.category?.entityId ?? null] });
      this.logger.log(`Low-stock alert sent for item ${row.item.id} in warehouse ${warehouseId} (${row.quantity} <= ${min})`);
    }
  }
}

/**
 * The item's own page. The resources list has no per-item deep link, so the
 * catalog's item page — readable by anybody with warehouse access — is the
 * one place that opens exactly this item.
 */
export const itemPath = (itemId: number) => `/catalog/items/${itemId}`;
