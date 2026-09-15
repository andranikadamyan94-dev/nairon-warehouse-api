-- A second name on catalog items (2026-09-14).
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "secondaryName" TEXT;
