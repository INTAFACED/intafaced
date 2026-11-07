-- svc-identity · one person, one account (I-kyc-compliance-14, J-identity-20 #4). A guided verification stores a keyed
-- fingerprint of the identity it names (legal name, date of birth, document type and number, nationality), never the
-- values. A request whose fingerprint matches another account's case is flagged with that account, for staff only: the
-- customer's own answers never name it, and a flagged case is never approved without a reviewer.
-- Reversal: the matching .down.sql
ALTER TABLE "identity"."kyc_cases" ADD COLUMN IF NOT EXISTS "identity_fingerprint" bytea;
ALTER TABLE "identity"."kyc_cases" ADD COLUMN IF NOT EXISTS "duplicate_of_user_id" uuid;
CREATE INDEX IF NOT EXISTS "kyc_cases_identity_fingerprint_idx"
  ON "identity"."kyc_cases" ("identity_fingerprint") WHERE "identity_fingerprint" IS NOT NULL;
