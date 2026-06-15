-- CreateTable
CREATE TABLE "SupplierItem" (
    "id" SERIAL NOT NULL,
    "supplierId" INTEGER NOT NULL,
    "itemId" INTEGER NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "SupplierItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SupplierItem_supplierId_itemId_key" ON "SupplierItem"("supplierId", "itemId");

-- CreateIndex
CREATE INDEX "SupplierItem_supplierId_idx" ON "SupplierItem"("supplierId");

-- CreateIndex
CREATE INDEX "SupplierItem_itemId_idx" ON "SupplierItem"("itemId");

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierItem" ADD CONSTRAINT "SupplierItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
