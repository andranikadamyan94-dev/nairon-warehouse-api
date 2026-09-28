-- 2026-09-29 (#2596-98): warehouses serve CRM projects, not backlogs. The old links cannot be
-- translated here (this database does not know which project a CRM backlog belonged to), so
-- warehouses are re-linked to projects by hand. Idempotent.
CREATE TABLE IF NOT EXISTS "WarehouseProject" (
  "id"          SERIAL PRIMARY KEY,
  "warehouseId" INTEGER NOT NULL,
  "projectId"   INTEGER NOT NULL,
  "projectName" TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
DO $$ BEGIN
  ALTER TABLE "WarehouseProject" ADD CONSTRAINT "WarehouseProject_warehouseId_fkey"
    FOREIGN KEY ("warehouseId") REFERENCES "Warehouse"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "WarehouseProject_projectId_key" ON "WarehouseProject"("projectId");
CREATE INDEX IF NOT EXISTS "WarehouseProject_warehouseId_idx" ON "WarehouseProject"("warehouseId");
DROP TABLE IF EXISTS "WarehouseBacklog";
