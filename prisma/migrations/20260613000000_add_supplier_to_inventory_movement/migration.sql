-- Add supplierId to InventoryMovement
ALTER TABLE "InventoryMovement" ADD COLUMN "supplierId" INTEGER;
ALTER TABLE "InventoryMovement" ADD CONSTRAINT "InventoryMovement_supplierId_fkey"
  FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "InventoryMovement_supplierId_idx" ON "InventoryMovement"("supplierId");
