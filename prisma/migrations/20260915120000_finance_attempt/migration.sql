-- Which submission attempt a record's finance operation keys belong to.
--
-- Existing rows start at 1, which is correct for them: every transfer they
-- already raised was their first and only attempt, and nothing retroactively
-- gains a second one. Procurement bumps this on `resubmit` — a deliberate
-- resubmission after finance rejection is a new financial operation. A
-- half-failed finalize does not bump it, because retrying that send must find
-- the transfers it already created instead of duplicating them.
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "financeAttempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "MaintenanceRecord" ADD COLUMN IF NOT EXISTS "financeAttempt" INTEGER NOT NULL DEFAULT 1;
