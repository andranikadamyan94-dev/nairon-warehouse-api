-- #1885/#1888-#1894 purchase requisitions — the demand side of procurement.
-- Idempotent throughout.

DO $$ BEGIN
  CREATE TYPE "PurchaseRequisitionStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED', 'FULFILLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PurchaseRequisition" (
  "id" SERIAL PRIMARY KEY,
  "uuid" TEXT NOT NULL,
  "status" "PurchaseRequisitionStatus" NOT NULL DEFAULT 'DRAFT',
  "title" TEXT,
  "comment" TEXT,
  "periodStart" DATE,
  "periodEnd" DATE,
  "entityId" INTEGER,
  "createdBy" INTEGER NOT NULL,
  "taskId" INTEGER,
  "taskOrigin" TEXT,
  "orderId" INTEGER,
  "rejectionReason" TEXT,
  "reviewedBy" INTEGER,
  "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "PurchaseRequisition_uuid_key" ON "PurchaseRequisition"("uuid");
CREATE INDEX IF NOT EXISTS "PurchaseRequisition_createdBy_idx" ON "PurchaseRequisition"("createdBy");
CREATE INDEX IF NOT EXISTS "PurchaseRequisition_status_idx" ON "PurchaseRequisition"("status");
CREATE INDEX IF NOT EXISTS "PurchaseRequisition_taskId_idx" ON "PurchaseRequisition"("taskId");
CREATE INDEX IF NOT EXISTS "PurchaseRequisition_orderId_idx" ON "PurchaseRequisition"("orderId");
DO $$ BEGIN
  ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PurchaseRequisitionLine" (
  "id" SERIAL PRIMARY KEY,
  "requisitionId" INTEGER NOT NULL,
  "itemId" INTEGER,
  "itemName" TEXT NOT NULL,
  "code" TEXT,
  "unit" "ItemUnit",
  "quantity" DOUBLE PRECISION NOT NULL,
  "stockQuantity" DOUBLE PRECISION,
  "expectedQuantity" DOUBLE PRECISION,
  "note" TEXT
);
CREATE INDEX IF NOT EXISTS "PurchaseRequisitionLine_requisitionId_idx" ON "PurchaseRequisitionLine"("requisitionId");
CREATE INDEX IF NOT EXISTS "PurchaseRequisitionLine_itemId_idx" ON "PurchaseRequisitionLine"("itemId");
DO $$ BEGIN
  ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_requisitionId_fkey"
    FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "PurchaseRequisitionLine" ADD CONSTRAINT "PurchaseRequisitionLine_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PurchaseRequisitionComment" (
  "id" SERIAL PRIMARY KEY,
  "requisitionId" INTEGER NOT NULL,
  "userId" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PurchaseRequisitionComment_requisitionId_idx" ON "PurchaseRequisitionComment"("requisitionId");
DO $$ BEGIN
  ALTER TABLE "PurchaseRequisitionComment" ADD CONSTRAINT "PurchaseRequisitionComment_requisitionId_fkey"
    FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "PurchaseRequisitionAttachment" (
  "id" SERIAL PRIMARY KEY,
  "requisitionId" INTEGER NOT NULL,
  "uploadedBy" INTEGER,
  "name" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "mimeType" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PurchaseRequisitionAttachment_requisitionId_idx" ON "PurchaseRequisitionAttachment"("requisitionId");
DO $$ BEGIN
  ALTER TABLE "PurchaseRequisitionAttachment" ADD CONSTRAINT "PurchaseRequisitionAttachment_requisitionId_fkey"
    FOREIGN KEY ("requisitionId") REFERENCES "PurchaseRequisition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
