-- Task requests through the catalog (owner 2026-10-08): the CRM task modal
-- reads one list, GET /catalog/submissions/task/:id. Every task request filed
-- before the catalog — a ResourceReservation with a task and no submission
-- (POST /reservations and PATCH /reservations/task/:id) — is wrapped into a
-- CatalogSubmission here. The old form sent several lines at once (and an
-- HOUR item as one row per working day), so rows filed by the same person
-- for the same task within the same minute become ONE submission:
--   number     from the catalog's own REQ sequence (REQ-####);
--   createdBy  whoever filed the first row of the group (its first
--              status-history row's performedBy; 0 when unknown);
--   entity/project/task from the first row;
--   purpose    the first row's note, else «Առաջադրանքի հայտ (մինչև կատալոգը)»;
--   neededBy   the group's latest end date (else its creation date);
--   createdAt  the group's earliest creation.
-- Idempotent: only rows still without a submission are touched, so a second
-- run does nothing; an empty table does nothing. Object rows without a task
-- were the previous migration's and are not touched here.
DO $$
DECLARE
  g    RECORD;
  who  INTEGER;
  note TEXT;
  what TEXT;
  sid  INTEGER;
BEGIN
  IF to_regclass('"CatalogSubmission"') IS NULL OR to_regclass('"ResourceReservation"') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'CatalogSubmission_number_seq' AND relkind = 'S') THEN
    CREATE SEQUENCE "CatalogSubmission_number_seq" AS INTEGER START WITH 1001 INCREMENT BY 1 NO CYCLE;
  END IF;
  FOR g IN
    SELECT
      r."taskId",
      COALESCE(f.who, 0) AS filer,
      date_trunc('minute', r."createdAt") AS minute,
      MIN(r.id) AS first_id,
      MIN(r."createdAt") AS first_at,
      MAX(r."endDate") AS last_end
    FROM "ResourceReservation" r
    LEFT JOIN LATERAL (
      SELECT h."performedBy" AS who
      FROM "ReservationStatusHistory" h
      WHERE h."reservationId" = r.id
      ORDER BY h."performedAt" ASC, h.id ASC
      LIMIT 1
    ) f ON TRUE
    WHERE r."taskId" IS NOT NULL AND r."submissionId" IS NULL
    GROUP BY r."taskId", COALESCE(f.who, 0), date_trunc('minute', r."createdAt")
    ORDER BY MIN(r.id)
  LOOP
    SELECT NULLIF(btrim(COALESCE(r.notes, '')), '') INTO note FROM "ResourceReservation" r WHERE r.id = g.first_id;
    what := COALESCE(note, 'Առաջադրանքի հայտ (մինչև կատալոգը)');
    who := g.filer;
    INSERT INTO "CatalogSubmission"
      ("number", "createdBy", "entityId", "projectId", "projectName", "objectId", "taskId", "purpose", "neededBy", "createdAt", "updatedAt")
    SELECT
      'REQ-' || lpad(nextval('"CatalogSubmission_number_seq"')::text, 4, '0'),
      who, r."entityId", r."projectId", r."projectName", r."objectId", r."taskId", what,
      COALESCE(g.last_end, g.first_at)::date, g.first_at, g.first_at
    FROM "ResourceReservation" r
    WHERE r.id = g.first_id
    RETURNING id INTO sid;
    UPDATE "ResourceReservation" r
    SET "submissionId" = sid
    WHERE r."taskId" = g."taskId"
      AND r."submissionId" IS NULL
      AND date_trunc('minute', r."createdAt") = g.minute
      AND COALESCE((
        SELECT h."performedBy" FROM "ReservationStatusHistory" h
        WHERE h."reservationId" = r.id
        ORDER BY h."performedAt" ASC, h.id ASC
        LIMIT 1
      ), 0) = g.filer;
  END LOOP;
END $$;
