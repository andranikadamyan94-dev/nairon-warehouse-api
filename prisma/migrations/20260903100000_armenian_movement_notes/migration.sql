-- Data repair (2026-09-03): the movement/history note templates the API used
-- to write were hardcoded English; the Շարժեր page now surfaces them, so the
-- code writes Armenian from here on and this migration translates the known
-- machine-written patterns already in the DB. Free-text user reasons are left
-- untouched (every UPDATE is anchored to an exact known template). All
-- statements are plain pattern-guarded UPDATEs — rerunning is a no-op.

-- ── InventoryMovement.notes ──────────────────────────────────────────────────
UPDATE "InventoryMovement" SET "notes" = regexp_replace("notes", '^Reservation #(\d+) approved$', 'Ամրագրում #\1 — տրված')
  WHERE "notes" ~ '^Reservation #\d+ approved$';
UPDATE "InventoryMovement" SET "notes" = regexp_replace("notes", '^Reservation #(\d+) allocation cancelled$', 'Ամրագրում #\1 — հատկացումը չեղարկված')
  WHERE "notes" ~ '^Reservation #\d+ allocation cancelled$';
UPDATE "InventoryMovement" SET "notes" = regexp_replace("notes", '^Returned from reservation #(\d+)$', 'Վերադարձ ամրագրում #\1-ից')
  WHERE "notes" ~ '^Returned from reservation #\d+$';
UPDATE "InventoryMovement" SET "notes" = regexp_replace("notes", '^Return #(\d+) received — (\d+) returned$', 'Վերադարձ #\1 ստացված — \2 հատ')
  WHERE "notes" ~ '^Return #\d+ received — \d+ returned$';
UPDATE "InventoryMovement" SET "notes" = regexp_replace("notes", '^Return #(\d+) received$', 'Վերադարձ #\1 ստացված')
  WHERE "notes" ~ '^Return #\d+ received$';
UPDATE "InventoryMovement" SET "notes" = regexp_replace("notes", '^Procurement order #(\d+), delivery #(\d+)$', 'Գնման պատվեր #\1, առաքում #\2')
  WHERE "notes" ~ '^Procurement order #\d+, delivery #\d+$';
-- retired template (pre-receiving-rework code wrote this)
UPDATE "InventoryMovement" SET "notes" = regexp_replace("notes", '^Procurement order #(\d+) received$', 'Գնման պատվեր #\1 — ստացված')
  WHERE "notes" ~ '^Procurement order #\d+ received$';
UPDATE "InventoryMovement" SET "notes" = 'Չեղարկված' WHERE "notes" = 'Cancelled';
UPDATE "InventoryMovement" SET "notes" = 'Մերժված' WHERE "notes" = 'Rejected';
UPDATE "InventoryMovement" SET "notes" = 'Ազատված՝ առաջադրանքի փոփոխության պատճառով' WHERE "notes" = 'Released due to task update';
UPDATE "InventoryMovement" SET "notes" = 'Ազատված՝ քանակի նվազման պատճառով' WHERE "notes" = 'Released due to quantity decrease';

-- ── ReservationAllocationHistory.notes ───────────────────────────────────────
UPDATE "ReservationAllocationHistory" SET "notes" = 'Ապրանքը տրված է' WHERE "notes" = 'Consumable approved';
UPDATE "ReservationAllocationHistory" SET "notes" = regexp_replace("notes", '^Reservation #(\d+) allocation cancelled$', 'Ամրագրում #\1 — հատկացումը չեղարկված')
  WHERE "notes" ~ '^Reservation #\d+ allocation cancelled$';
UPDATE "ReservationAllocationHistory" SET "notes" = regexp_replace("notes", '^Returned (\d+) unit\(s\) to warehouse$', '\1 հատ վերադարձվել է պահեստ')
  WHERE "notes" ~ '^Returned \d+ unit\(s\) to warehouse$';
UPDATE "ReservationAllocationHistory" SET "notes" = regexp_replace("notes", '^Return #(\d+) received — (\d+) returned$', 'Վերադարձ #\1 ստացված — \2 հատ')
  WHERE "notes" ~ '^Return #\d+ received — \d+ returned$';
UPDATE "ReservationAllocationHistory" SET "notes" = regexp_replace("notes", '^Return #(\d+) received$', 'Վերադարձ #\1 ստացված')
  WHERE "notes" ~ '^Return #\d+ received$';
UPDATE "ReservationAllocationHistory" SET "notes" = 'Չեղարկված' WHERE "notes" = 'Cancelled';
UPDATE "ReservationAllocationHistory" SET "notes" = 'Մերժված' WHERE "notes" = 'Rejected';
UPDATE "ReservationAllocationHistory" SET "notes" = 'Ազատված՝ առաջադրանքի փոփոխության պատճառով' WHERE "notes" = 'Released due to task update';
UPDATE "ReservationAllocationHistory" SET "notes" = 'Ազատված՝ քանակի նվազման պատճառով' WHERE "notes" = 'Released due to quantity decrease';

-- ── ReservationStatusHistory.reason ──────────────────────────────────────────
UPDATE "ReservationStatusHistory" SET "reason" = 'Առաջադրանքը թարմացվել է' WHERE "reason" = 'Task updated';
UPDATE "ReservationStatusHistory" SET "reason" = 'Ռեսուրսը հեռացվել է առաջադրանքից' WHERE "reason" = 'Resource removed from task';
UPDATE "ReservationStatusHistory" SET "reason" = regexp_replace("reason", '^Return #(\d+) received$', 'Վերադարձ #\1 ստացված')
  WHERE "reason" ~ '^Return #\d+ received$';
