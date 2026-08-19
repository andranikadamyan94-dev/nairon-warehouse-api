-- Low-stock threshold per item. NULL = no alerting (opt-in per item).
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "minQuantity" DOUBLE PRECISION;

-- Latch so the alert fires once per breach rather than on every write while
-- stock sits below the threshold. Cleared when quantity recovers above it.
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "lowStockNotifiedAt" TIMESTAMP(3);
