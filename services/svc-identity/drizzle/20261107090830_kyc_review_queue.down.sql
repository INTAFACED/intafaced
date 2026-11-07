-- Reverses the verification review queue: claims and internal notes go; the cases themselves stay.
DROP TABLE IF EXISTS "identity"."kyc_case_notes";
DROP INDEX IF EXISTS "identity"."kyc_cases_open_queue_idx";
ALTER TABLE "identity"."kyc_cases" DROP COLUMN IF EXISTS "assigned_at";
ALTER TABLE "identity"."kyc_cases" DROP COLUMN IF EXISTS "assigned_to";
