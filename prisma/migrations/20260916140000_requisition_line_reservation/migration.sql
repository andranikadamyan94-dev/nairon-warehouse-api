-- A requisition line raised for a reservation that could not be covered from
-- stock remembers which one (2026-09-16), so the reservation can show the
-- request that is on its way. Idempotent.
ALTER TABLE "PurchaseRequisitionLine" ADD COLUMN IF NOT EXISTS "reservationId" INTEGER;
CREATE INDEX IF NOT EXISTS "PurchaseRequisitionLine_reservationId_idx" ON "PurchaseRequisitionLine"("reservationId");
