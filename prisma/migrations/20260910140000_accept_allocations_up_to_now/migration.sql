-- Widens the previous backfill (20260910120000) from "issued before the
-- 2026-09-05 release" to "issued before this runs": every reservation that
-- exists at deploy time and was never accepted is treated as accepted, and
-- only what the warehouse issues afterwards waits for a task to confirm it.
--
-- Same rules as before: acceptedQuantity becomes what was actually issued,
-- never more than what was requested; a reservation whose whole requested
-- quantity was issued reaches COMPLETED with a status-history row; cancelled
-- and rejected reservations are left alone. Idempotent — rows the earlier
-- migration already accepted no longer match.

INSERT INTO "ReservationStatusHistory"
  ("reservationId", "fromStatus", "toStatus", "previousQuantity", "newQuantity", "performedBy", "reason", "performedAt")
SELECT
  r."id",
  r."status",
  'COMPLETED'::"ResourceReservationStatus",
  r."acceptedQuantity",
  LEAST(i.qty, r."quantity"),
  NULL,
  'Ընդունված է ինքնաշխատ․ տրամադրումը կատարվել է ընդունման հաստատումը ներդնելուց առաջ',
  NOW()
FROM "ResourceReservation" r
JOIN (
  SELECT "reservationId" AS id, SUM("quantity")::int AS qty
  FROM "ReservationAllocation"
  WHERE "releasedAt" IS NULL
  GROUP BY "reservationId"
) i ON i.id = r."id"
WHERE r."acceptedQuantity" = 0
  AND i.qty > 0
  AND i.qty >= r."quantity"
  AND r."createdAt" < NOW()
  AND r."status" NOT IN ('CANCELLED', 'REJECTED', 'COMPLETED');

UPDATE "ResourceReservation" r
SET "acceptedQuantity" = LEAST(i.qty, r."quantity"),
    "status" = CASE
      WHEN i.qty >= r."quantity" THEN 'COMPLETED'::"ResourceReservationStatus"
      ELSE r."status"
    END,
    "updatedAt" = NOW()
FROM (
  SELECT "reservationId" AS id, SUM("quantity")::int AS qty
  FROM "ReservationAllocation"
  WHERE "releasedAt" IS NULL
  GROUP BY "reservationId"
) i
WHERE i.id = r."id"
  AND r."acceptedQuantity" = 0
  AND i.qty > 0
  AND r."createdAt" < NOW()
  AND r."status" NOT IN ('CANCELLED', 'REJECTED');
