-- Task-side acceptance of issued materials (the 2026-09-01 handshake) reached
-- production with the 2026-09-05 release. Everything the warehouse had already
-- issued before that was handed over under the old rules, but shows on tasks as
-- still waiting to be accepted, because acceptedQuantity starts at 0.
--
-- Treat those older allocations as accepted: acceptedQuantity becomes what was
-- actually issued (never more than what was requested), and a reservation whose
-- whole requested quantity was issued reaches COMPLETED, exactly as an
-- acceptance in the app would leave it.
--
-- Idempotent: only reservations that have never been accepted are touched, so a
-- second run matches nothing. Cancelled and rejected reservations are left
-- alone, and so is anything issued after the cutoff — those are for the task to
-- accept by hand.

-- The audit trail first, while the old status is still readable.
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
  AND r."createdAt" < TIMESTAMP '2026-09-05'
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
  AND r."createdAt" < TIMESTAMP '2026-09-05'
  AND r."status" NOT IN ('CANCELLED', 'REJECTED');
