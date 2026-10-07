-- Project duplicate (2026-10-07): crm-api copies a project tree and asks this
-- service to copy its warehouse rows (POST /api/internal/project-copies).
-- Every row the copy makes carries the crm ProjectCopyJob id, so a repeat is
-- answered from the stored result and a rollback deletes exactly those rows.
-- Guarded, as always.
ALTER TABLE "WarehouseProject" ADD COLUMN IF NOT EXISTS "copyJobId" UUID;
CREATE INDEX IF NOT EXISTS "WarehouseProject_copyJobId_idx" ON "WarehouseProject"("copyJobId");
ALTER TABLE "ObjectEstimateLine" ADD COLUMN IF NOT EXISTS "copyJobId" UUID;
CREATE INDEX IF NOT EXISTS "ObjectEstimateLine_copyJobId_idx" ON "ObjectEstimateLine"("copyJobId");
ALTER TABLE "ResourceReservation" ADD COLUMN IF NOT EXISTS "copyJobId" UUID;
CREATE INDEX IF NOT EXISTS "ResourceReservation_copyJobId_idx" ON "ResourceReservation"("copyJobId");
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "copyJobId" UUID;
CREATE INDEX IF NOT EXISTS "PurchaseRequisition_copyJobId_idx" ON "PurchaseRequisition"("copyJobId");
ALTER TABLE "CatalogSubmission" ADD COLUMN IF NOT EXISTS "copyJobId" UUID;
CREATE INDEX IF NOT EXISTS "CatalogSubmission_copyJobId_idx" ON "CatalogSubmission"("copyJobId");
ALTER TABLE "AssetRequest" ADD COLUMN IF NOT EXISTS "copyJobId" UUID;
CREATE INDEX IF NOT EXISTS "AssetRequest_copyJobId_idx" ON "AssetRequest"("copyJobId");

CREATE TABLE IF NOT EXISTS "WarehouseProjectCopy" (
    "jobId" UUID NOT NULL,
    "counts" JSONB NOT NULL,
    "reset" JSONB NOT NULL,
    "files" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WarehouseProjectCopy_pkey" PRIMARY KEY ("jobId")
);
