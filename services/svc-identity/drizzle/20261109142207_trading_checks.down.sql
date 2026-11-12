-- Reverses 20261109142207_trading_checks.sql. The kyc_records a check opened stay (a cleared level is revoked by
-- compliance, not by a schema change); only the check rows and the sealed dates of birth go.
-- intafaced:destructive drops every sealed sign-up date of birth and every trading check outcome.
DROP TABLE IF EXISTS "identity"."trading_checks";
DROP TABLE IF EXISTS "identity"."birth_dates";
ALTER TABLE "identity"."signup_drafts" DROP COLUMN IF EXISTS "birth_nonce";
ALTER TABLE "identity"."signup_drafts" DROP COLUMN IF EXISTS "birth_ciphertext";
