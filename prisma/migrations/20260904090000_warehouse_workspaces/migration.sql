-- #1989 wave 2 — warehouse workspaces: per-warehouse assets, staff membership,
-- sub→main return transfers, and the sub→main resource-request flow.
-- Guarded for reruns.

ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "warehouseId" INTEGER;
CREATE INDEX IF NOT EXISTS "Asset_warehouseId_idx" ON "Asset"("warehouseId");
DO $$ BEGIN
  ALTER TABLE "Asset" ADD CONSTRAINT "Asset_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "StockTransfer" ADD COLUMN IF NOT EXISTS "direction" TEXT NOT NULL DEFAULT 'TO_SUB';

CREATE TABLE IF NOT EXISTS "WarehouseEmployee" (
  "id" SERIAL PRIMARY KEY,
  "warehouseId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "WarehouseEmployee_warehouseId_userId_key" ON "WarehouseEmployee"("warehouseId", "userId");
CREATE INDEX IF NOT EXISTS "WarehouseEmployee_userId_idx" ON "WarehouseEmployee"("userId");
DO $$ BEGIN
  ALTER TABLE "WarehouseEmployee" ADD CONSTRAINT "WarehouseEmployee_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockRequest" (
  "id" SERIAL PRIMARY KEY,
  "uuid" TEXT NOT NULL,
  "warehouseId" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "comment" TEXT,
  "rejectionReason" TEXT,
  "createdBy" INTEGER,
  "decidedBy" INTEGER,
  "decidedAt" TIMESTAMP(3),
  "transferId" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "StockRequest_uuid_key" ON "StockRequest"("uuid");
CREATE INDEX IF NOT EXISTS "StockRequest_warehouseId_idx" ON "StockRequest"("warehouseId");
CREATE INDEX IF NOT EXISTS "StockRequest_status_idx" ON "StockRequest"("status");
DO $$ BEGIN
  ALTER TABLE "StockRequest" ADD CONSTRAINT "StockRequest_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "StockRequestItem" (
  "id" SERIAL PRIMARY KEY,
  "requestId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "StockRequestItem_requestId_idx" ON "StockRequestItem"("requestId");
DO $$ BEGIN
  ALTER TABLE "StockRequestItem" ADD CONSTRAINT "StockRequestItem_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "StockRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockRequestItem" ADD CONSTRAINT "StockRequestItem_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
