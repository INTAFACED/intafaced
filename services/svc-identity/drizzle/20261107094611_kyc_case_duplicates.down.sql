-- Reverses the duplicate-identity flag: fingerprints and flags go; the cases stay.
DROP INDEX IF EXISTS "identity"."kyc_cases_identity_fingerprint_idx";
ALTER TABLE "identity"."kyc_cases" DROP COLUMN IF EXISTS "duplicate_of_user_id";
ALTER TABLE "identity"."kyc_cases" DROP COLUMN IF EXISTS "identity_fingerprint";
