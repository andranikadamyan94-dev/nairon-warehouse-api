-- Catalog «Հիշեցնել աշխատակցին» (2026-10-07): the desk reminds the submitter of
-- an unanswered information request. The last reminder (when + who) limits
-- reminders to one per request per hour through a conditional update; every
-- reminder is kept as {at, by} for the request's history. Guarded, as always.
ALTER TABLE "CatalogSubmission" ADD COLUMN IF NOT EXISTS "lastReminderAt" TIMESTAMP(3);
ALTER TABLE "CatalogSubmission" ADD COLUMN IF NOT EXISTS "lastReminderBy" INTEGER;
ALTER TABLE "CatalogSubmission" ADD COLUMN IF NOT EXISTS "reminders" JSONB NOT NULL DEFAULT '[]';
