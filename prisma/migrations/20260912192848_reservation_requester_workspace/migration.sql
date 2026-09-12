-- AlterTable
ALTER TABLE "ResourceReservation" ADD COLUMN     "requesterWorkspaceId" INTEGER;

-- CreateIndex
CREATE INDEX "ResourceReservation_requesterWorkspaceId_idx" ON "ResourceReservation"("requesterWorkspaceId");
