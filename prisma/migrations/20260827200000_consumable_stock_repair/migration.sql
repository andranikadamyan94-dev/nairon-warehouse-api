-- Data repair for the consumable double-deduction bug (fixed in code by
-- "stop double-counting handed-out consumables"). Until that fix, updating a
-- task's reservations could flip delivered consumables back to PENDING, and a
-- second warehouse approval deducted the full quantity from stock again,
-- leaving reservations whose unreleased allocations exceed their quantity and
-- Item.quantity lower than reality.
--
-- Pass 1 releases the excess allocations (newest first — the duplicates),
-- credits the stock back, and writes compensating ledger rows so the
-- InventoryMovement audit trail explains itself.
-- Pass 2 recomputes active consumable reservation statuses from what is
-- actually allocated, so phantom PENDING/APPROVED rows settle.
--
-- Both passes converge: once no reservation is over-allocated and no status
-- disagrees with its allocations, re-running changes nothing (idempotent).
-- Rejected/cancelled reservations are deliberately untouched — a phantom
-- PENDING that staff rejected released its allocations without restoring
-- stock, and whether the goods came back cannot be decided by a script.

DO $$
DECLARE
  r RECORD;
  a RECORD;
  excess INT;
  released_now INT;
  repaired_reservations INT := 0;
  credited_total INT := 0;
BEGIN
  FOR r IN
    SELECT res.id, res."itemId", res."taskId", res.quantity,
           COALESCE(SUM(al.quantity), 0)::int AS allocated
    FROM "ResourceReservation" res
    JOIN "Item" i ON i.id = res."itemId" AND i.type = 'CONSUMABLE'
    JOIN "ReservationAllocation" al
      ON al."reservationId" = res.id AND al."releasedAt" IS NULL
    GROUP BY res.id
    HAVING COALESCE(SUM(al.quantity), 0) > res.quantity
  LOOP
    excess := r.allocated - r.quantity;

    FOR a IN
      SELECT id, quantity FROM "ReservationAllocation"
      WHERE "reservationId" = r.id AND "releasedAt" IS NULL
      ORDER BY "allocatedAt" DESC, id DESC
    LOOP
      EXIT WHEN excess <= 0;
      IF a.quantity <= excess THEN
        UPDATE "ReservationAllocation" SET "releasedAt" = NOW() WHERE id = a.id;
        released_now := a.quantity;
      ELSE
        -- The duplicate only partially overlaps this row: shrink it instead.
        UPDATE "ReservationAllocation" SET quantity = a.quantity - excess WHERE id = a.id;
        released_now := excess;
      END IF;
      excess := excess - released_now;

      INSERT INTO "ReservationAllocationHistory" ("uuid", "reservationId", "action", "notes")
      VALUES (gen_random_uuid()::text, r.id, 'RELEASED',
              'Data repair: duplicate approval excess (' || released_now || ') released');
    END LOOP;

    UPDATE "Item" SET quantity = quantity + (r.allocated - r.quantity) WHERE id = r."itemId";

    INSERT INTO "InventoryMovement" ("uuid", "itemId", "quantity", "type", "taskId", "notes")
    VALUES (gen_random_uuid()::text, r."itemId", (r.allocated - r.quantity), 'IN', r."taskId",
            'Data repair: reversing duplicate approval of reservation #' || r.id);

    repaired_reservations := repaired_reservations + 1;
    credited_total := credited_total + (r.allocated - r.quantity);
  END LOOP;

  RAISE NOTICE 'consumable repair pass 1: % over-allocated reservation(s), % unit(s) credited back to stock',
    repaired_reservations, credited_total;
END $$;

DO $$
DECLARE
  r RECORD;
  new_status "ResourceReservationStatus";
  fixed INT := 0;
BEGIN
  FOR r IN
    SELECT res.id, res.status, res.quantity,
           COALESCE(SUM(al.quantity) FILTER (WHERE al."releasedAt" IS NULL), 0)::int AS allocated
    FROM "ResourceReservation" res
    JOIN "Item" i ON i.id = res."itemId" AND i.type = 'CONSUMABLE'
    LEFT JOIN "ReservationAllocation" al ON al."reservationId" = res.id
    WHERE res.status IN ('PENDING', 'APPROVED', 'PARTIALLY_ALLOCATED')
    GROUP BY res.id
  LOOP
    IF r.allocated > 0 AND r.allocated >= r.quantity THEN
      new_status := 'ALLOCATED';
    ELSIF r.allocated > 0 THEN
      new_status := 'PARTIALLY_ALLOCATED';
    ELSE
      CONTINUE;
    END IF;

    IF new_status <> r.status THEN
      UPDATE "ResourceReservation" SET status = new_status WHERE id = r.id;
      INSERT INTO "ReservationStatusHistory" ("reservationId", "fromStatus", "toStatus", "reason")
      VALUES (r.id, r.status, new_status, 'Data repair: status recomputed from actual allocations');
      fixed := fixed + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'consumable repair pass 2: % status(es) recomputed', fixed;
END $$;
