-- Task-side acceptance of issued goods (2026-09-01 handshake):
-- accepted ≤ issued ≤ requested; full acceptance completes the reservation.
ALTER TABLE "ResourceReservation" ADD COLUMN IF NOT EXISTS "acceptedQuantity" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ResourceReservation" ADD COLUMN IF NOT EXISTS "acceptanceComment" TEXT;
