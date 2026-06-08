-- AlterTable
ALTER TABLE "Supplier" ADD COLUMN     "actingAddress" TEXT,
ADD COLUMN     "bankAccount" TEXT,
ADD COLUMN     "bankName" TEXT,
ADD COLUMN     "deadline" TIMESTAMP(3),
ADD COLUMN     "managers" JSONB,
ADD COLUMN     "registryNumber" TEXT;
