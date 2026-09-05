-- Transfers become multi-line documents (user request 2026-09-03): item lines
-- move to StockTransferItem; the backlog and the two employee fields are
-- dropped from the form and the model. Existing single-item rows migrate into
-- lines. Guarded for reruns.

CREATE TABLE IF NOT EXISTS "StockTransferItem" (
  "id" SERIAL PRIMARY KEY,
  "transferId" INTEGER NOT NULL,
  "itemId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS "StockTransferItem_transferId_idx" ON "StockTransferItem"("transferId");
CREATE INDEX IF NOT EXISTS "StockTransferItem_itemId_idx" ON "StockTransferItem"("itemId");
DO $$ BEGIN
  ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_transferId_fkey"
    FOREIGN KEY ("transferId") REFERENCES "StockTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "StockTransferItem" ADD CONSTRAINT "StockTransferItem_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Existing single-item transfers become one-line documents.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'StockTransfer' AND column_name = 'itemId') THEN
    INSERT INTO "StockTransferItem" ("transferId", "itemId", "quantity")
    SELECT st."id", st."itemId", st."quantity" FROM "StockTransfer" st
    WHERE NOT EXISTS (SELECT 1 FROM "StockTransferItem" i WHERE i."transferId" = st."id");
  END IF;
END $$;

ALTER TABLE "StockTransfer" DROP COLUMN IF EXISTS "itemId";
ALTER TABLE "StockTransfer" DROP COLUMN IF EXISTS "quantity";
ALTER TABLE "StockTransfer" DROP COLUMN IF EXISTS "backlogId";
ALTER TABLE "StockTransfer" DROP COLUMN IF EXISTS "issuedById";
ALTER TABLE "StockTransfer" DROP COLUMN IF EXISTS "receivedById";
