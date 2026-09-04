-- Delivery documents carry a number (invoice/waybill №) — required by the API
-- on every new delivery; old rows stay NULL.
ALTER TABLE "ProcurementDelivery" ADD COLUMN IF NOT EXISTS "documentNumber" TEXT;
