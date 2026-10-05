-- Warehouse catalog, phase A (2026-10-01): richer items. Brand/model/description, a stocking
-- mode, catalog visibility, variants as child items (parentItemId + variantLabel), and three
-- child tables: characteristics, gallery images, documents. Every statement guarded, as always.

DO $$ BEGIN CREATE TYPE "ItemStockingMode" AS ENUM ('STOCKED', 'ON_REQUEST'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "brand" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "model" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "description" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "stockingMode" "ItemStockingMode" NOT NULL DEFAULT 'STOCKED';
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "catalogVisible" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "parentItemId" INTEGER;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "variantLabel" TEXT;

CREATE INDEX IF NOT EXISTS "Item_parentItemId_idx" ON "Item"("parentItemId");

-- A parent cannot be deleted while it still has variants (the service refuses first, in Armenian).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Item_parentItemId_fkey') THEN
    ALTER TABLE "Item" ADD CONSTRAINT "Item_parentItemId_fkey"
      FOREIGN KEY ("parentItemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ItemAttribute" (
  "id"     SERIAL PRIMARY KEY,
  "itemId" INTEGER NOT NULL,
  "name"   TEXT NOT NULL,
  "value"  TEXT NOT NULL,
  "order"  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "ItemAttribute_itemId_idx" ON "ItemAttribute"("itemId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ItemAttribute_itemId_fkey') THEN
    ALTER TABLE "ItemAttribute" ADD CONSTRAINT "ItemAttribute_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ItemImage" (
  "id"      SERIAL PRIMARY KEY,
  "itemId"  INTEGER NOT NULL,
  "url"     TEXT NOT NULL,
  "order"   INTEGER NOT NULL DEFAULT 0,
  "isCover" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS "ItemImage_itemId_idx" ON "ItemImage"("itemId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ItemImage_itemId_fkey') THEN
    ALTER TABLE "ItemImage" ADD CONSTRAINT "ItemImage_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "ItemDocument" (
  "id"     SERIAL PRIMARY KEY,
  "itemId" INTEGER NOT NULL,
  "url"    TEXT NOT NULL,
  "name"   TEXT NOT NULL,
  "size"   INTEGER NOT NULL,
  "mime"   TEXT NOT NULL,
  "order"  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "ItemDocument_itemId_idx" ON "ItemDocument"("itemId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ItemDocument_itemId_fkey') THEN
    ALTER TABLE "ItemDocument" ADD CONSTRAINT "ItemDocument_itemId_fkey"
      FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
