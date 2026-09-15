-- Weighed goods are stored as double precision, so every receipt and issue
-- leaves binary residue behind: a 12.3 kg item with 12 kg issued sits at
-- 0.30000000000000071 rather than 0.3, and that number reaches the screen and
-- the "is any left" comparisons after it.
--
-- Round what is already stored to the three decimals the warehouse actually
-- measures. Derived figures are rounded in the service from now on, and the
-- columns themselves become exact decimals when that change lands.
--
-- Idempotent: rounding an already-rounded value is a no-op. Each table is
-- guarded, so the file runs on production, which has no purchase
-- requisitions yet, exactly as it runs on staging.

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Item',
    'InventoryMovement',
    'ProcurementOrderItem',
    'ProcurementDeliveryItem',
    'PurchaseRequisitionLine'
  ] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format(
        'UPDATE %I SET "quantity" = ROUND("quantity"::numeric, 3) ' ||
        'WHERE "quantity" IS NOT NULL ' ||
        'AND "quantity" <> ROUND("quantity"::numeric, 3)::double precision',
        t
      );
    END IF;
  END LOOP;
END $$;
