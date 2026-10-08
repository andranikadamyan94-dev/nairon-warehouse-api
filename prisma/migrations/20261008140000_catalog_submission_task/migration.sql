-- Task requests through the catalog (2026-10-08): a CatalogSubmission filed
-- for a CRM task by one of its people remembers the task; its reservations
-- carry the same taskId (and the task's object). Guarded, as always.
ALTER TABLE "CatalogSubmission" ADD COLUMN IF NOT EXISTS "taskId" INTEGER;
CREATE INDEX IF NOT EXISTS "CatalogSubmission_taskId_idx" ON "CatalogSubmission"("taskId");
