-- Merchant require-MFA restriction on a session (M-plat-org-06, org-access-019). No balance, no ledger.
-- Reversal: 0067_session_merchant_mfa.down.sql
--
-- Set at sign-in when the merchant owner's rule (read from svc-pay) requires MFA and the session did not pass a
-- second factor: `enrol_required` (no factor enrolled) or `second_step_required` (a factor exists, this sign-in did
-- not use it). Such a session carries enrolment scopes only, and a refresh copies the value to the successor row, so
-- the restriction ends only with a new sign-in. NULL: an ordinary session (every existing row).

ALTER TABLE "identity"."sessions" ADD COLUMN IF NOT EXISTS "merchant_mfa" text
  CONSTRAINT "sessions_merchant_mfa_known" CHECK ("merchant_mfa" IN ('enrol_required', 'second_step_required'));
