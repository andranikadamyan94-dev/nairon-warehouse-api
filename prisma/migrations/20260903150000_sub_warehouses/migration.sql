-- #1989 sub-warehouses: Warehouse / WarehouseBacklog / WarehouseStock /
-- StockTransfer + warehouseId dimensions on movements and reservations.
-- The MAIN warehouse row is identity only — its stock is Item.quantity, so no
-- stock data moves anywhere. Everything guarded for reruns.

DO $$ BEGIN
  CREATE TYPE "WarehouseType" AS ENUM ('MAIN', 'PROJECT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "WarehouseStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "Warehouse" (
  "id" SERIAL PRIMARY KEY,
  "uuid" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "type" "WarehouseType" NOT NULL DEFAULT 'PROJECT',
  "responsibleId" INTEGER,
  "location" TEXT,
  "status" "WarehouseStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdBy" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "Warehouse_uuid_key" ON "Warehouse"("uuid");
CREATE UNIQUE INDEX IF NOT EXISTS "Warehouse_code_key" ON "Warehouse"("code");
CREATE INDEX IF NOT EXISTS "Warehouse_type_idx" ON "Warehouse"("type");
CREATE INDEX IF NOT EXISTS "Warehouse_status_idx" ON "Warehouse"("status");

CREATE TABLE IF NOT EXISTS "WarehouseBacklog" (
  "id" SERIAL PRIMARY KEY,
  "warehouseId" INTEGER NOT NULL,
  "backlogId" INTEGER NOT NULL,
  "backlogName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "WarehouseBacklog_backlogId_key" ON "WarehouseBacklog"("backlogId");
CREATE INDEX IF NOT EXISTS "WarehouseBacklog_warehouseId_idx" ON "WarehouseBacklog"("warehouseId");
DO $$ BEGIN
  ALTER TABLE "WarehouseBacklog" ADD CONSTRAINT "WarehouseBacklog_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "WarehouseStock" (
  "id" SERIAL PRIMARY KEY,
  "warehouseId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "WarehouseStock_warehouseId_itemId_key" ON "WarehouseStock"("warehouseId", "itemId");
CREATE INDEX IF NOT EXISTS "WarehouseStock_itemId_idx" ON "WarehouseStock"("itemId");
DO $$ BEGIN
  ALTER TABLE "WarehouseStock" ADD CONSTRAINT "WarehouseStock_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "WarehouseStock" ADD CONSTRAINT "WarehouseStock_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockTransfer" (
  "id" SERIAL PRIMARY KEY,
  "uuid" TEXT NOT NULL,
  "toWarehouseId" INTEGER NOT NULL,
  "backlogId" INTEGER,
  "itemId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL,
  "transferDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "issuedById" INTEGER,
  "receivedById" INTEGER,
  "comment" TEXT,
  "createdBy" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "StockTransfer_uuid_key" ON "StockTransfer"("uuid");
CREATE INDEX IF NOT EXISTS "StockTransfer_toWarehouseId_idx" ON "StockTransfer"("toWarehouseId");
CREATE INDEX IF NOT EXISTS "StockTransfer_itemId_idx" ON "StockTransfer"("itemId");
DO $$ BEGIN
  ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_toWarehouseId_fkey"
    FOREIGN KEY ("toWarehouseId") REFERENCES "Warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockTransfer" ADD CONSTRAINT "StockTransfer_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "InventoryMovement" ADD COLUMN IF NOT EXISTS "warehouseId" INTEGER;
CREATE INDEX IF NOT EXISTS "InventoryMovement_warehouseId_idx" ON "InventoryMovement"("warehouseId");
DO $$ BEGIN
  ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "ResourceReservation" ADD COLUMN IF NOT EXISTS "warehouseId" INTEGER;
DO $$ BEGIN
  ALTER TABLE "ResourceReservation" ADD CONSTRAINT "ResourceReservation_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Seed the main warehouse (identity only; stock stays Item.quantity).
INSERT INTO "Warehouse" ("uuid", "name", "code", "type", "status", "updatedAt")
SELECT gen_random_uuid()::text, 'Հիմնական պահեստ', 'MAIN', 'MAIN', 'ACTIVE', CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Warehouse" WHERE "type" = 'MAIN');

-- Straggler from the notes-i18n pass: this template was half-translated so the
-- pure-English sweep missed it.
UPDATE "InventoryMovement" SET "notes" = regexp_replace("notes", '^Reservation #(\d+) — չընդունված քանակի վերադարձ$', 'Ամրագրում #\1 — չընդունված քանակի վերադարձ')
  WHERE "notes" ~ '^Reservation #\d+ — չընդունված քանակի վերադարձ$';
