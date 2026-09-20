-- AlterTable
ALTER TABLE "ResourceReservation" ADD COLUMN IF NOT EXISTS "requesterWorkspaceId" INTEGER;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ResourceReservation_requesterWorkspaceId_idx" ON "ResourceReservation"("requesterWorkspaceId");
