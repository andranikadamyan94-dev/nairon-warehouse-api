-- Price corrections after receipt (2026-09-22). Every statement guarded.
ALTER TYPE "ProcurementPaymentType" ADD VALUE IF NOT EXISTS 'ADJUSTMENT';
ALTER TYPE "ProcurementPaymentType" ADD VALUE IF NOT EXISTS 'REFUND';
ALTER TABLE "ProcurementOrderItem" ADD COLUMN IF NOT EXISTS "invoicedUnitPrice" DOUBLE PRECISION;
ALTER TABLE "ProcurementDeliveryItem" ADD COLUMN IF NOT EXISTS "unitPrice" DOUBLE PRECISION;
ALTER TABLE "ProcurementPayment" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "ProcurementPayment" ADD COLUMN IF NOT EXISTS "documentNumber" TEXT;
ALTER TABLE "ProcurementPayment" ADD COLUMN IF NOT EXISTS "createdBy" INTEGER;
