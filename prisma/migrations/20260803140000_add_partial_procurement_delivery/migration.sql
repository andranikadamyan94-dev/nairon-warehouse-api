-- Partial delivery of procurement orders.

-- New order statuses. ADD VALUE cannot run inside a transaction block in older
-- PGs, hence the guarded DO blocks rather than a plain ALTER TYPE.
DO $$ BEGIN
    ALTER TYPE "ProcurementOrderStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_RECEIVED';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TYPE "ProcurementOrderStatus" ADD VALUE IF NOT EXISTS 'CLOSED_SHORT';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE "ProcurementPaymentType" AS ENUM ('PREPAYMENT', 'BALANCE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Per-line received rollup.
ALTER TABLE "ProcurementOrderItem"
    ADD COLUMN IF NOT EXISTS "receivedQuantity" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Short-settlement bookkeeping on the order.
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "closedShortAt" TIMESTAMP(3);
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "closedShortReason" TEXT;

CREATE TABLE IF NOT EXISTS "ProcurementDelivery" (
    "id"         SERIAL NOT NULL,
    "orderId"    INTEGER NOT NULL,
    "receiptUrl" TEXT,
    "notes"      TEXT,
    "receivedBy" INTEGER,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProcurementDelivery_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ProcurementDelivery_orderId_idx" ON "ProcurementDelivery"("orderId");

CREATE TABLE IF NOT EXISTS "ProcurementDeliveryItem" (
    "id"          SERIAL NOT NULL,
    "deliveryId"  INTEGER NOT NULL,
    "orderItemId" INTEGER NOT NULL,
    "quantity"    DOUBLE PRECISION NOT NULL,
    CONSTRAINT "ProcurementDeliveryItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ProcurementDeliveryItem_deliveryId_idx" ON "ProcurementDeliveryItem"("deliveryId");
CREATE INDEX IF NOT EXISTS "ProcurementDeliveryItem_orderItemId_idx" ON "ProcurementDeliveryItem"("orderItemId");

CREATE TABLE IF NOT EXISTS "ProcurementPayment" (
    "id"                SERIAL NOT NULL,
    "orderId"           INTEGER NOT NULL,
    "type"              "ProcurementPaymentType" NOT NULL,
    "amount"            DOUBLE PRECISION NOT NULL,
    "financeTransferId" INTEGER,
    "status"            TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProcurementPayment_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "ProcurementPayment_orderId_idx" ON "ProcurementPayment"("orderId");
CREATE INDEX IF NOT EXISTS "ProcurementPayment_financeTransferId_idx" ON "ProcurementPayment"("financeTransferId");

DO $$ BEGIN
    ALTER TABLE "ProcurementDelivery"
        ADD CONSTRAINT "ProcurementDelivery_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ProcurementDeliveryItem"
        ADD CONSTRAINT "ProcurementDeliveryItem_deliveryId_fkey"
        FOREIGN KEY ("deliveryId") REFERENCES "ProcurementDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ProcurementDeliveryItem"
        ADD CONSTRAINT "ProcurementDeliveryItem_orderItemId_fkey"
        FOREIGN KEY ("orderItemId") REFERENCES "ProcurementOrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "ProcurementPayment"
        ADD CONSTRAINT "ProcurementPayment_orderId_fkey"
        FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Backfill: orders already RECEIVED arrived in full, so their lines are fully
-- received. Synthesise one delivery per such order from the receipt it already
-- carries, so the new delivery history isn't empty for past orders.
UPDATE "ProcurementOrderItem" oi
SET "receivedQuantity" = oi."quantity"
FROM "ProcurementOrder" o
WHERE o."id" = oi."orderId"
  AND o."status" = 'RECEIVED'
  AND oi."receivedQuantity" = 0;

INSERT INTO "ProcurementDelivery" ("orderId", "receiptUrl", "notes", "receivedAt")
SELECT o."id", o."receiptUrl", 'Backfilled from the pre-partial-delivery receipt',
       COALESCE(o."receivedAt", o."updatedAt")
FROM "ProcurementOrder" o
WHERE o."status" = 'RECEIVED'
  AND NOT EXISTS (SELECT 1 FROM "ProcurementDelivery" d WHERE d."orderId" = o."id");

INSERT INTO "ProcurementDeliveryItem" ("deliveryId", "orderItemId", "quantity")
SELECT d."id", oi."id", oi."quantity"
FROM "ProcurementDelivery" d
JOIN "ProcurementOrderItem" oi ON oi."orderId" = d."orderId"
WHERE d."notes" = 'Backfilled from the pre-partial-delivery receipt'
  AND NOT EXISTS (
      SELECT 1 FROM "ProcurementDeliveryItem" di
      WHERE di."deliveryId" = d."id" AND di."orderItemId" = oi."id"
  );
