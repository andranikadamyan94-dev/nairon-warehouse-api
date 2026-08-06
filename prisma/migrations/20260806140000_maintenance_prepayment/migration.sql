-- Deposits on maintenance jobs, mirroring procurement: a maintainer who wants
-- money before starting gets its own transfer, and the balance transfer covers
-- what is left.
--
-- Guarded so re-running is a no-op.

ALTER TABLE "MaintenanceRecord" ADD COLUMN IF NOT EXISTS "prepaymentAmount"     DOUBLE PRECISION;
ALTER TABLE "MaintenanceRecord" ADD COLUMN IF NOT EXISTS "prepaymentTransferId" INTEGER;
