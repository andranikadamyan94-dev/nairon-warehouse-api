-- Warehouse catalog, phases B/C (2026-10-02): one row per «Ուղարկել հարցումը». A submission groups
-- the N reservations + 1 purchase requisition a checkout makes; its number comes from a sequence
-- starting at 1001 (REQ-1001, REQ-1002, …). Reservations and requisitions get a nullable pointer
-- back to it — NULL for every row made outside the catalog, which keep working as before.
-- Every statement guarded, as always.

CREATE TABLE IF NOT EXISTS "CatalogSubmission" (
  "id"              SERIAL PRIMARY KEY,
  "number"          TEXT NOT NULL,
  "createdBy"       INTEGER NOT NULL,
  "entityId"        INTEGER,
  "projectId"       INTEGER,
  "projectName"     TEXT,
  "costCenter"      TEXT,
  "purpose"         TEXT NOT NULL,
  "neededBy"        DATE NOT NULL,
  "comment"         TEXT,
  "attachmentUrl"   TEXT,
  "infoRequestText" TEXT,
  "infoRequestBy"   INTEGER,
  "infoRequestAt"   TIMESTAMP(3),
  "cancelledAt"     TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "CatalogSubmission_number_key" ON "CatalogSubmission"("number");
CREATE INDEX IF NOT EXISTS "CatalogSubmission_createdBy_idx" ON "CatalogSubmission"("createdBy");
CREATE INDEX IF NOT EXISTS "CatalogSubmission_entityId_idx" ON "CatalogSubmission"("entityId");
CREATE INDEX IF NOT EXISTS "CatalogSubmission_createdAt_idx" ON "CatalogSubmission"("createdAt");

-- The REQ-#### counter. Starts at 1001 so the first submission reads REQ-1001.
CREATE SEQUENCE IF NOT EXISTS "CatalogSubmission_number_seq" AS INTEGER START WITH 1001 INCREMENT BY 1 NO CYCLE;

ALTER TABLE "ResourceReservation" ADD COLUMN IF NOT EXISTS "submissionId" INTEGER;
CREATE INDEX IF NOT EXISTS "ResourceReservation_submissionId_idx" ON "ResourceReservation"("submissionId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ResourceReservation_submissionId_fkey') THEN
    ALTER TABLE "ResourceReservation" ADD CONSTRAINT "ResourceReservation_submissionId_fkey"
      FOREIGN KEY ("submissionId") REFERENCES "CatalogSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "submissionId" INTEGER;
CREATE INDEX IF NOT EXISTS "PurchaseRequisition_submissionId_idx" ON "PurchaseRequisition"("submissionId");
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PurchaseRequisition_submissionId_fkey') THEN
    ALTER TABLE "PurchaseRequisition" ADD CONSTRAINT "PurchaseRequisition_submissionId_fkey"
      FOREIGN KEY ("submissionId") REFERENCES "CatalogSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
