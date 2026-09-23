-- Asset custody (2026-09-23): who holds an asset (person or construction object),
-- how it got there, and requests for assets. Every statement guarded; the
-- legacy AssetResponsibility rows are copied in once, the table itself stays.

DO $$ BEGIN CREATE TYPE "AssetHolderType" AS ENUM ('USER', 'OBJECT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AssetCustodyVia" AS ENUM ('TASK_ALLOCATION', 'PERSONAL_REQUEST', 'DIRECT_ISSUE', 'OBJECT_REASSIGN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AssetRequestKind" AS ENUM ('PERSONAL', 'OBJECT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AssetRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ISSUED', 'CANCELLED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "AssetReleaseCondition" AS ENUM ('OK', 'DAMAGED', 'LOST'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AssetRequest" (
  "id" SERIAL PRIMARY KEY,
  "uuid" TEXT NOT NULL,
  "kind" "AssetRequestKind" NOT NULL DEFAULT 'PERSONAL',
  "entityId" INTEGER,
  "requestedBy" INTEGER NOT NULL,
  "forUserId" INTEGER,
  "forObjectId" INTEGER,
  "itemId" INTEGER NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "reason" TEXT,
  "status" "AssetRequestStatus" NOT NULL DEFAULT 'PENDING',
  "decidedBy" INTEGER,
  "decidedAt" TIMESTAMP(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetRequest_uuid_key" ON "AssetRequest"("uuid");
CREATE INDEX IF NOT EXISTS "AssetRequest_forUserId_idx" ON "AssetRequest"("forUserId");
CREATE INDEX IF NOT EXISTS "AssetRequest_forObjectId_idx" ON "AssetRequest"("forObjectId");
CREATE INDEX IF NOT EXISTS "AssetRequest_status_idx" ON "AssetRequest"("status");
CREATE INDEX IF NOT EXISTS "AssetRequest_requestedBy_idx" ON "AssetRequest"("requestedBy");
DO $$ BEGIN
  ALTER TABLE "AssetRequest" ADD CONSTRAINT "AssetRequest_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "AssetCustody" (
  "id" SERIAL PRIMARY KEY,
  "uuid" TEXT NOT NULL,
  "assetId" INTEGER NOT NULL,
  "holderType" "AssetHolderType" NOT NULL DEFAULT 'USER',
  "holderUserId" INTEGER,
  "holderObjectId" INTEGER,
  "originObjectId" INTEGER,
  "via" "AssetCustodyVia" NOT NULL DEFAULT 'DIRECT_ISSUE',
  "requestId" INTEGER,
  "reservationId" INTEGER,
  "assignedBy" INTEGER,
  "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "releasedAt" TIMESTAMP(3),
  "releasedBy" INTEGER,
  "releaseCondition" "AssetReleaseCondition",
  "notes" TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetCustody_uuid_key" ON "AssetCustody"("uuid");
CREATE INDEX IF NOT EXISTS "AssetCustody_assetId_idx" ON "AssetCustody"("assetId");
CREATE INDEX IF NOT EXISTS "AssetCustody_holderUserId_idx" ON "AssetCustody"("holderUserId");
CREATE INDEX IF NOT EXISTS "AssetCustody_holderObjectId_idx" ON "AssetCustody"("holderObjectId");
CREATE INDEX IF NOT EXISTS "AssetCustody_releasedAt_idx" ON "AssetCustody"("releasedAt");
DO $$ BEGIN
  ALTER TABLE "AssetCustody" ADD CONSTRAINT "AssetCustody_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "AssetCustody" ADD CONSTRAINT "AssetCustody_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AssetRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Legacy responsibilities become person custody, accepted at assignment
-- (nobody could confirm receipt before). Runs once: only while the new table is empty.
INSERT INTO "AssetCustody" ("uuid", "assetId", "holderType", "holderUserId", "via", "assignedBy", "assignedAt", "acceptedAt", "releasedAt", "notes")
SELECT gen_random_uuid()::text, r."assetId", 'USER', r."userId", 'DIRECT_ISSUE', r."assignedBy", r."assignedAt", r."assignedAt", r."releasedAt", r."notes"
FROM "AssetResponsibility" r
WHERE NOT EXISTS (SELECT 1 FROM "AssetCustody");
