-- Which organization a purchase is made for (2026-09-10). Orders carried no
-- organization at all, so the finance transfers they raise landed with none
-- either and the spend could not be reported per organization.
--
-- Nullable on purpose: every order placed before this has no answer, and
-- guessing one would be worse than leaving it blank for a super-admin to fill
-- in. Guarded so a re-run is a no-op.
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "entityId" INTEGER;

CREATE INDEX IF NOT EXISTS "ProcurementOrder_entityId_idx" ON "ProcurementOrder"("entityId");
