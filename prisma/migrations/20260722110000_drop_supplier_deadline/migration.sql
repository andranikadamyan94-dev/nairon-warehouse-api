-- Remove the vestigial, unused `deadline` column from Supplier.
ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "deadline";
