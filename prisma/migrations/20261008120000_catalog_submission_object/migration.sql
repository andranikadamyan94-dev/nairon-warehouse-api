-- Object requests through the catalog (2026-10-08): a CatalogSubmission filed
-- for a construction object by its responsible person remembers the object;
-- its reservations carry the same objectId. Guarded, as always.
ALTER TABLE "CatalogSubmission" ADD COLUMN IF NOT EXISTS "objectId" INTEGER;
CREATE INDEX IF NOT EXISTS "CatalogSubmission_objectId_idx" ON "CatalogSubmission"("objectId");
