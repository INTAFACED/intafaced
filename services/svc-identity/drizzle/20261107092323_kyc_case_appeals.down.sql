-- Reverses appeals on verification cases: the appeals go; the cases stay, none of them final.
DROP TABLE IF EXISTS "identity"."kyc_case_appeals";
ALTER TABLE "identity"."kyc_cases" DROP COLUMN IF EXISTS "final";
