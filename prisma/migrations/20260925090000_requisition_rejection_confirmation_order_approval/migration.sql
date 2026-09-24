-- 2026-09-25 (owner's hotfix): a requisition rejection at either stage waits
-- for confirm_requisition_rejection; a procurement order waits for
-- approve_purchase_order before finance hears of it. Every statement is
-- guarded so the migration is safe to re-run.
ALTER TYPE "PurchaseRequisitionStatus" ADD VALUE IF NOT EXISTS 'REJECTION_PENDING';
ALTER TYPE "ProcurementOrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';

ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "rejectionRequestedBy" INTEGER;
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "rejectionRequestedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "rejectionStage" TEXT;
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "rejectionReturnStatus" "PurchaseRequisitionStatus";
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "rejectionConfirmedBy" INTEGER;
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "rejectionConfirmedAt" TIMESTAMP(3);
ALTER TABLE "PurchaseRequisition" ADD COLUMN IF NOT EXISTS "rejectionDeclineNote" TEXT;

ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "submittedForApprovalBy" INTEGER;
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "submittedForApprovalAt" TIMESTAMP(3);
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "approvedBy" INTEGER;
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "approvalRejectedBy" INTEGER;
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "approvalRejectedAt" TIMESTAMP(3);
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "approvalRejectionReason" TEXT;
