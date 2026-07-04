-- CreateEnum
CREATE TYPE "MaintenanceStatus" AS ENUM ('DRAFT', 'PENDING_FINANCE', 'FINANCE_APPROVED', 'FINANCE_REJECTED', 'IN_PROGRESS', 'COMPLETED');

-- AlterEnum
ALTER TYPE "ProcurementOrderStatus" ADD VALUE 'FINANCE_REJECTED';

-- DropIndex
DROP INDEX "InventoryMovement_supplierId_idx";

-- AlterTable
ALTER TABLE "MaintenanceRecord" ADD COLUMN     "amount" DOUBLE PRECISION,
ADD COLUMN     "financeTransferId" INTEGER,
ADD COLUMN     "maintainerId" INTEGER,
ADD COLUMN     "status" "MaintenanceStatus" NOT NULL DEFAULT 'DRAFT';

-- AlterTable
ALTER TABLE "ProcurementOrder" ADD COLUMN     "receiptUrl" TEXT;

-- CreateTable
CREATE TABLE "Maintainer" (
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

-- CreateIndex
CREATE UNIQUE INDEX "Maintainer_uuid_key" ON "Maintainer"("uuid");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_maintainerId_idx" ON "MaintenanceRecord"("maintainerId");

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_maintainerId_fkey" FOREIGN KEY ("maintainerId") REFERENCES "Maintainer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
