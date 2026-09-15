-- Purchase requisitions gain an approval step inside the requester's
-- organization before procurement sees them (2026-09-11).
ALTER TYPE "PurchaseRequisitionStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "decidedBy" INTEGER;
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "decidedAt" TIMESTAMP(3);
