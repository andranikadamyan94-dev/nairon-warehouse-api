-- Give Maintainer the same fields as Supplier (except the catalogue/resource list).
ALTER TABLE "Maintainer" ADD COLUMN IF NOT EXISTS "actingAddress" TEXT;
ALTER TABLE "Maintainer" ADD COLUMN IF NOT EXISTS "managers" JSONB;
ALTER TABLE "Maintainer" ADD COLUMN IF NOT EXISTS "bankName" TEXT;
ALTER TABLE "Maintainer" ADD COLUMN IF NOT EXISTS "bankAccount" TEXT;
ALTER TABLE "Maintainer" ADD COLUMN IF NOT EXISTS "registryNumber" TEXT;
