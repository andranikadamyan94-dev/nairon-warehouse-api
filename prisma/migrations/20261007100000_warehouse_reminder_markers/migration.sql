-- Notifications phase 3 (2026-10-07): the daily 09:00 Asia/Yerevan reminder
-- run (maintenance due, assets due back, receipts unconfirmed). One row per
-- reminder kind, record and Yerevan day: the run claims the row before it
-- sends, so a restart, a second replica or a re-run the same day sends
-- nothing twice. Guarded, as always.
CREATE TABLE IF NOT EXISTS "WarehouseReminderMarker" (
    "id" SERIAL NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WarehouseReminderMarker_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WarehouseReminderMarker_kind_refId_day_key" ON "WarehouseReminderMarker"("kind", "refId", "day");
CREATE INDEX IF NOT EXISTS "WarehouseReminderMarker_day_idx" ON "WarehouseReminderMarker"("day");
