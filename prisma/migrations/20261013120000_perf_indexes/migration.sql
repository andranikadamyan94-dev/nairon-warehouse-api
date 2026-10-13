-- Performance audit 2026-10-13: indexes for the hot list reads — the catalog
-- grid and category tabs, stock availability per item/warehouse/status, the
-- movements register (newest first, per warehouse), object/task scopes on the
-- ledger, the assets list (newest first) and the procurement list.
-- Idempotent: every statement is IF NOT EXISTS, so a re-run does nothing.

CREATE INDEX IF NOT EXISTS "Item_parentItemId_catalogVisible_name_idx" ON "Item"("parentItemId", "catalogVisible", "name");
CREATE INDEX IF NOT EXISTS "Item_categoryId_idx" ON "Item"("categoryId");
CREATE INDEX IF NOT EXISTS "Asset_createdAt_idx" ON "Asset"("createdAt");
CREATE INDEX IF NOT EXISTS "InventoryMovement_createdAt_idx" ON "InventoryMovement"("createdAt");
CREATE INDEX IF NOT EXISTS "InventoryMovement_warehouseId_createdAt_idx" ON "InventoryMovement"("warehouseId", "createdAt");
CREATE INDEX IF NOT EXISTS "InventoryMovement_taskId_idx" ON "InventoryMovement"("taskId");
CREATE INDEX IF NOT EXISTS "ResourceReservation_itemId_warehouseId_status_idx" ON "ResourceReservation"("itemId", "warehouseId", "status");
CREATE INDEX IF NOT EXISTS "ProcurementOrder_createdAt_id_idx" ON "ProcurementOrder"("createdAt", "id");
