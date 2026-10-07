-- Notifications phase 2 (2026-10-06): low stock per sub-warehouse. The same
-- latch Item.lowStockNotifiedAt gives the main pool, on each sub's stock row:
-- set when the alert is sent, cleared when the stock recovers above the
-- item's minQuantity. Guarded, as always.
ALTER TABLE "WarehouseStock" ADD COLUMN IF NOT EXISTS "lowStockNotifiedAt" TIMESTAMP(3);
