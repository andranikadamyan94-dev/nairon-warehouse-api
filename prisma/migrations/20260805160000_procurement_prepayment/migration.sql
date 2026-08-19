-- Supplier deposit on a procurement order. The order raises two finance
-- transfers when this is set: the prepayment (payable before delivery) and the
-- balance (payable once the order closes).
--
-- Guarded so re-running is a no-op.

ALTER TABLE "ProcurementOrder" ADD COLUMN IF NOT EXISTS "prepaymentAmount" DOUBLE PRECISION;
