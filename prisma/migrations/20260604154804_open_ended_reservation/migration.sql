-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('CONSUMABLE', 'ASSET');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('AVAILABLE', 'MAINTENANCE', 'DAMAGED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ResourceReservationStatus" AS ENUM ('PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'COMPLETED', 'CANCELLED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReservationAllocationAction" AS ENUM ('ALLOCATED', 'RELEASED', 'REALLOCATED', 'RETURNED');

-- CreateEnum
CREATE TYPE "ProcurementOrderStatus" AS ENUM ('DRAFT', 'ORDERED', 'RECEIVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ItemUnit" AS ENUM ('KG', 'TONNE', 'METER', 'PIECE', 'HOUR');

-- CreateTable
CREATE TABLE "Item" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "type" "ItemType" NOT NULL,
    "unit" "ItemUnit",
    "quantity" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "categoryId" INTEGER,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT,
    "itemId" INTEGER NOT NULL,
    "serialNumber" TEXT,
    "status" "AssetStatus" NOT NULL DEFAULT 'AVAILABLE',
    "responsibleUserId" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryMovement" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "itemId" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "type" TEXT NOT NULL,
    "taskId" INTEGER,
    "performedBy" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InventoryMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResourceReservation" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "itemId" INTEGER NOT NULL,
    "taskId" INTEGER,
    "projectId" INTEGER,
    "projectName" TEXT,
    "entityId" INTEGER,
    "entityName" TEXT,
    "quantity" INTEGER NOT NULL,
    "status" "ResourceReservationStatus" NOT NULL DEFAULT 'PENDING',
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3),
    "notes" TEXT,
    "replacedByReservationId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceReservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationStatusHistory" (
    "id" SERIAL NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "fromStatus" "ResourceReservationStatus",
    "toStatus" "ResourceReservationStatus" NOT NULL,
    "previousQuantity" INTEGER,
    "newQuantity" INTEGER,
    "performedBy" INTEGER,
    "reason" TEXT,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationAllocation" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "assetId" INTEGER,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allocatedBy" INTEGER,
    "releasedAt" TIMESTAMP(3),

    CONSTRAINT "ReservationAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationAllocationHistory" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "assetId" INTEGER,
    "action" "ReservationAllocationAction" NOT NULL,
    "performedBy" INTEGER,
    "notes" TEXT,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationAllocationHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaintenanceRecord" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "assetId" INTEGER NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "type" TEXT,
    "notes" TEXT,
    "createdBy" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaintenanceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetResponsibility" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "assetId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "assignedBy" INTEGER,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssetResponsibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementOrder" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "status" "ProcurementOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "supplierId" INTEGER,
    "notes" TEXT,
    "createdBy" INTEGER,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcurementOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcurementOrderItem" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unitPrice" DOUBLE PRECISION,

    CONSTRAINT "ProcurementOrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ItemCategory" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL DEFAULT 1,
    "parentId" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ItemCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Item_uuid_key" ON "Item"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Item_code_key" ON "Item"("code");

-- CreateIndex
CREATE INDEX "Item_type_idx" ON "Item"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_uuid_key" ON "Asset"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "Asset_serialNumber_key" ON "Asset"("serialNumber");

-- CreateIndex
CREATE INDEX "Asset_itemId_idx" ON "Asset"("itemId");

-- CreateIndex
CREATE INDEX "Asset_status_idx" ON "Asset"("status");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryMovement_uuid_key" ON "InventoryMovement"("uuid");

-- CreateIndex
CREATE INDEX "InventoryMovement_itemId_idx" ON "InventoryMovement"("itemId");

-- CreateIndex
CREATE INDEX "InventoryMovement_type_idx" ON "InventoryMovement"("type");

-- CreateIndex
CREATE UNIQUE INDEX "ResourceReservation_uuid_key" ON "ResourceReservation"("uuid");

-- CreateIndex
CREATE INDEX "ResourceReservation_itemId_idx" ON "ResourceReservation"("itemId");

-- CreateIndex
CREATE INDEX "ResourceReservation_taskId_idx" ON "ResourceReservation"("taskId");

-- CreateIndex
CREATE INDEX "ResourceReservation_projectId_idx" ON "ResourceReservation"("projectId");

-- CreateIndex
CREATE INDEX "ResourceReservation_entityId_idx" ON "ResourceReservation"("entityId");

-- CreateIndex
CREATE INDEX "ResourceReservation_status_idx" ON "ResourceReservation"("status");

-- CreateIndex
CREATE INDEX "ResourceReservation_startDate_endDate_idx" ON "ResourceReservation"("startDate", "endDate");

-- CreateIndex
CREATE INDEX "ReservationStatusHistory_reservationId_idx" ON "ReservationStatusHistory"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationStatusHistory_performedAt_idx" ON "ReservationStatusHistory"("performedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationAllocation_uuid_key" ON "ReservationAllocation"("uuid");

-- CreateIndex
CREATE INDEX "ReservationAllocation_reservationId_idx" ON "ReservationAllocation"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationAllocation_assetId_idx" ON "ReservationAllocation"("assetId");

-- CreateIndex
CREATE INDEX "ReservationAllocation_releasedAt_idx" ON "ReservationAllocation"("releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReservationAllocationHistory_uuid_key" ON "ReservationAllocationHistory"("uuid");

-- CreateIndex
CREATE INDEX "ReservationAllocationHistory_reservationId_idx" ON "ReservationAllocationHistory"("reservationId");

-- CreateIndex
CREATE INDEX "ReservationAllocationHistory_assetId_idx" ON "ReservationAllocationHistory"("assetId");

-- CreateIndex
CREATE INDEX "ReservationAllocationHistory_action_idx" ON "ReservationAllocationHistory"("action");

-- CreateIndex
CREATE UNIQUE INDEX "MaintenanceRecord_uuid_key" ON "MaintenanceRecord"("uuid");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_assetId_idx" ON "MaintenanceRecord"("assetId");

-- CreateIndex
CREATE INDEX "MaintenanceRecord_startDate_endDate_idx" ON "MaintenanceRecord"("startDate", "endDate");

-- CreateIndex
CREATE UNIQUE INDEX "AssetResponsibility_uuid_key" ON "AssetResponsibility"("uuid");

-- CreateIndex
CREATE INDEX "AssetResponsibility_assetId_idx" ON "AssetResponsibility"("assetId");

-- CreateIndex
CREATE INDEX "AssetResponsibility_userId_idx" ON "AssetResponsibility"("userId");

-- CreateIndex
CREATE INDEX "AssetResponsibility_releasedAt_idx" ON "AssetResponsibility"("releasedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_uuid_key" ON "Supplier"("uuid");

-- CreateIndex
CREATE UNIQUE INDEX "ProcurementOrder_uuid_key" ON "ProcurementOrder"("uuid");

-- CreateIndex
CREATE INDEX "ProcurementOrder_supplierId_idx" ON "ProcurementOrder"("supplierId");

-- CreateIndex
CREATE INDEX "ProcurementOrder_status_idx" ON "ProcurementOrder"("status");

-- CreateIndex
CREATE INDEX "ProcurementOrderItem_orderId_idx" ON "ProcurementOrderItem"("orderId");

-- CreateIndex
CREATE INDEX "ProcurementOrderItem_itemId_idx" ON "ProcurementOrderItem"("itemId");

-- CreateIndex
CREATE INDEX "ItemCategory_entityId_idx" ON "ItemCategory"("entityId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ItemCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReservation" ADD CONSTRAINT "ResourceReservation_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResourceReservation" ADD CONSTRAINT "ResourceReservation_replacedByReservationId_fkey" FOREIGN KEY ("replacedByReservationId") REFERENCES "ResourceReservation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationStatusHistory" ADD CONSTRAINT "ReservationStatusHistory_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "ResourceReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationAllocation" ADD CONSTRAINT "ReservationAllocation_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "ResourceReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationAllocation" ADD CONSTRAINT "ReservationAllocation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationAllocationHistory" ADD CONSTRAINT "ReservationAllocationHistory_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "ResourceReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationAllocationHistory" ADD CONSTRAINT "ReservationAllocationHistory_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaintenanceRecord" ADD CONSTRAINT "MaintenanceRecord_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetResponsibility" ADD CONSTRAINT "AssetResponsibility_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementOrder" ADD CONSTRAINT "ProcurementOrder_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementOrderItem" ADD CONSTRAINT "ProcurementOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "ProcurementOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcurementOrderItem" ADD CONSTRAINT "ProcurementOrderItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ItemCategory" ADD CONSTRAINT "ItemCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ItemCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
