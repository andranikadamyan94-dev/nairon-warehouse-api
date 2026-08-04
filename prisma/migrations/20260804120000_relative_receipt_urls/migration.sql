-- Receipt URLs were stored absolute, built from PUBLIC_API_URL — which was set
-- nowhere, so rows written on any deployed environment carry
-- "http://localhost:<port>/uploads/<file>" and resolve to the reader's own
-- machine. Rewrite every absolute value to the path-only form the code now
-- stores, keeping the filename.
--
-- Idempotent: rows already relative contain no '://' and are left alone.

UPDATE "ProcurementOrder"
SET "receiptUrl" = '/uploads/' || regexp_replace("receiptUrl", '^.*/uploads/', '')
WHERE "receiptUrl" LIKE '%://%'
  AND "receiptUrl" LIKE '%/uploads/%';

UPDATE "ProcurementDelivery"
SET "receiptUrl" = '/uploads/' || regexp_replace("receiptUrl", '^.*/uploads/', '')
WHERE "receiptUrl" LIKE '%://%'
  AND "receiptUrl" LIKE '%/uploads/%';
