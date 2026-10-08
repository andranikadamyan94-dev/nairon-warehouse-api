-- Object requests through the catalog (owner 2026-10-08): the CRM object page
-- reads one list, GET /catalog/submissions/object/:id. Every object request
-- filed before the catalog — a ResourceReservation with an object, no task and
-- no submission (the old POST /reservations/object/:id and the warehouse's
-- direct supplies) — is wrapped into its own CatalogSubmission here:
--   number     from the catalog's own REQ sequence (REQ-####);
--   createdBy  whoever filed it (the first status-history row's performedBy; 0 when unknown);
--   entity/project from the reservation;
--   purpose    the reservation's note, else the note the history carried
--              («Օբյեկտի հայտ — …»), «Պահեստից՝ առանց հայտի» for a direct
--              supply, else «Պահեստային հայտ (մինչև կատալոգը)»;
--   neededBy   the reservation's end date (else its creation date);
--   createdAt  the reservation's.
-- Idempotent: only rows still without a submission are touched, so a second
-- run does nothing; an empty table does nothing. Task rows stamped with an
-- object (#2042) are a task's, not an object request, and are left alone.
DO $$
DECLARE
  r   RECORD;
  who INTEGER;
  why TEXT;
  what TEXT;
  sid INTEGER;
BEGIN
  IF to_regclass('"CatalogSubmission"') IS NULL OR to_regclass('"ResourceReservation"') IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'CatalogSubmission_number_seq' AND relkind = 'S') THEN
    CREATE SEQUENCE "CatalogSubmission_number_seq" AS INTEGER START WITH 1001 INCREMENT BY 1 NO CYCLE;
  END IF;
  FOR r IN
    SELECT id, "objectId", "entityId", "projectId", "projectName", notes, "endDate", "createdAt"
    FROM "ResourceReservation"
    WHERE "objectId" IS NOT NULL AND "submissionId" IS NULL AND "taskId" IS NULL
    ORDER BY id
  LOOP
    who := NULL;
    why := NULL;
    SELECT h."performedBy", h.reason INTO who, why
    FROM "ReservationStatusHistory" h
    WHERE h."reservationId" = r.id
    ORDER BY h."performedAt" ASC, h.id ASC
    LIMIT 1;
    what := CASE
      WHEN why = 'Պահեստը տրամադրում է օբյեկտին' THEN 'Պահեստից՝ առանց հայտի'
      WHEN NULLIF(btrim(COALESCE(r.notes, '')), '') IS NOT NULL THEN btrim(r.notes)
      WHEN why LIKE 'Օբյեկտի հայտ — %' THEN substr(why, char_length('Օբյեկտի հայտ — ') + 1)
      ELSE 'Պահեստային հայտ (մինչև կատալոգը)'
    END;
    INSERT INTO "CatalogSubmission"
      ("number", "createdBy", "entityId", "projectId", "projectName", "objectId", "purpose", "neededBy", "createdAt", "updatedAt")
    VALUES
      ('REQ-' || lpad(nextval('"CatalogSubmission_number_seq"')::text, 4, '0'),
       COALESCE(who, 0), r."entityId", r."projectId", r."projectName", r."objectId", what,
       COALESCE(r."endDate", r."createdAt")::date, r."createdAt", r."createdAt")
    RETURNING id INTO sid;
    UPDATE "ResourceReservation" SET "submissionId" = sid WHERE id = r.id;
  END LOOP;
END $$;
