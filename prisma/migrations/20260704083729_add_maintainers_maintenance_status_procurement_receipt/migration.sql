-- CreateEnum (idempotent)
DO $$ BEGIN
  CREATE TYPE "MaintenanceStatus" AS ENUM ('DRAFT', 'PENDING_FINANCE', 'FINANCE_APPROVED', 'FINANCE_REJECTED', 'IN_PROGRESS', 'COMPLETED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- AlterEnum (idempotent)
DO $$ BEGIN
  ALTER TYPE "ProcurementOrderStatus" ADD VALUE 'FINANCE_REJECTED';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- DropIndex (idempotent)
DROP INDEX IF EXISTS "InventoryMovement_supplierId_idx";

-- AlterTable MaintenanceRecord (idempotent)
ALTER TABLE "MaintenanceRecord"
  ADD COLUMN IF NOT EXISTS "amount" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "financeTransferId" INTEGER,
  ADD COLUMN IF NOT EXISTS "maintainerId" INTEGER,
  ADD COLUMN IF NOT EXISTS "status" "MaintenanceStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable ProcurementOrder (idempotent)
ALTER TABLE "ProcurementOrder"
  ADD COLUMN IF NOT EXISTS "receiptUrl" TEXT;

-- CreateTable (idempotent)
CREATE TABLE IF NOT EXISTS "Maintainer" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Maintainer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "Maintainer_uuid_key" ON "Maintainer"("uuid");

-- CreateIndex (idempotent)
CREATE INDEX IF NOT EXISTS "MaintenanceRecord_maintainerId_idx" ON "MaintenanceRecord"("maintainerId");

-- AddForeignKey (idempotent)
DO $$ BEGIN
  ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_maintainerId_fkey"
    FOREIGN KEY ("maintainerId") REFERENCES "Maintainer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
