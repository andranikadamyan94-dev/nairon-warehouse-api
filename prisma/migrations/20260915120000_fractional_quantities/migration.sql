-- Fractional quantities (2026-09-15): resources can be requested, issued,
-- transferred, returned and stocked in parts (0.3 kg, 1.5 m). The remaining
-- integer quantity columns become double precision, the type Item.quantity
-- and InventoryMovement.quantity already have. Guarded: only columns still
-- typed integer are altered, so re-running is harmless.
DO $$
DECLARE
  spec text[];
BEGIN
  FOREACH spec SLICE 1 IN ARRAY ARRAY[
    ARRAY['WarehouseStock', 'quantity'],
    ARRAY['StockTransferItem', 'quantity'],
    ARRAY['StockRequestItem', 'quantity'],
    ARRAY['ResourceReservation', 'quantity'],
    ARRAY['ResourceReservation', 'acceptedQuantity'],
    ARRAY['ReservationStatusHistory', 'previousQuantity'],
    ARRAY['ReservationStatusHistory', 'newQuantity'],
    ARRAY['ReservationAllocation', 'quantity'],
    ARRAY['ResourceReturn', 'quantity']
  ]
  LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = spec[1] AND column_name = spec[2]
        AND data_type IN ('integer', 'bigint', 'smallint')
    ) THEN
      EXECUTE format('ALTER TABLE %I ALTER COLUMN %I TYPE DOUBLE PRECISION USING %I::double precision', spec[1], spec[2], spec[2]);
    END IF;
  END LOOP;
END $$;
