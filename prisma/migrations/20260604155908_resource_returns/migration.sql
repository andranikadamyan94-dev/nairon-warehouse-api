-- CreateEnum
CREATE TYPE "ResourceReturnStatus" AS ENUM ('PENDING', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "ResourceReturn" (
    "id" SERIAL NOT NULL,
    "uuid" TEXT NOT NULL,
    "reservationId" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "ResourceReturnStatus" NOT NULL DEFAULT 'PENDING',
    "notes" TEXT,
    "requestedBy" INTEGER,
    "receivedBy" INTEGER,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResourceReturn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ResourceReturn_uuid_key" ON "ResourceReturn"("uuid");

-- CreateIndex
CREATE INDEX "ResourceReturn_reservationId_idx" ON "ResourceReturn"("reservationId");

-- CreateIndex
CREATE INDEX "ResourceReturn_status_idx" ON "ResourceReturn"("status");

-- AddForeignKey
ALTER TABLE "ResourceReturn" ADD CONSTRAINT "ResourceReturn_reservationId_fkey" FOREIGN KEY ("reservationId") REFERENCES "ResourceReservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
