-- #2042 cost layer: object attribution + frozen costs on the movement ledger,
-- manually-maintained current unit cost on items, and estimate lines per
-- construction object (object ids live in CRM). Guarded for reruns.

ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "unitCost" DOUBLE PRECISION;

ALTER TABLE "InventoryMovement" ADD COLUMN IF NOT EXISTS "objectId" INTEGER;
ALTER TABLE "InventoryMovement" ADD COLUMN IF NOT EXISTS "unitCost" DOUBLE PRECISION;
ALTER TABLE "InventoryMovement" ADD COLUMN IF NOT EXISTS "totalCost" DOUBLE PRECISION;
CREATE INDEX IF NOT EXISTS "InventoryMovement_objectId_idx" ON "InventoryMovement"("objectId");

ALTER TABLE "ResourceReservation" ADD COLUMN IF NOT EXISTS "objectId" INTEGER;

CREATE TABLE IF NOT EXISTS "ObjectEstimateLine" (
  "id" SERIAL PRIMARY KEY,
  "objectId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "plannedQuantity" DOUBLE PRECISION NOT NULL,
  "plannedUnitCost" DOUBLE PRECISION,
  "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ObjectEstimateLine_objectId_itemId_key" ON "ObjectEstimateLine"("objectId", "itemId");
CREATE INDEX IF NOT EXISTS "ObjectEstimateLine_objectId_idx" ON "ObjectEstimateLine"("objectId");
DO $$ BEGIN
  ALTER TABLE "ObjectEstimateLine" ADD CONSTRAINT "ObjectEstimateLine_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
