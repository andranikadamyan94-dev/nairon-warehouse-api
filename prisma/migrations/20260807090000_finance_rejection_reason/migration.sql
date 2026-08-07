-- Somewhere to keep the reason finance gave for turning a request down.
--
-- Finance has always sent `rejectionReason` on the callback, and CRM already
-- reads it. The warehouse controllers destructured only `status`, so the reason
-- was dropped on arrival: the list showed a red FINANCE_REJECTED tag with no
-- explanation, and finding out meant asking finance directly.
ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "financeRejectionReason" TEXT;
ALTER TABLE "MaintenanceRecord" ADD COLUMN IF NOT EXISTS "financeRejectionReason" TEXT;
