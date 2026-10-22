-- TEAM-WIDE TWO-STEP SIGN-IN RULE (M-plat-org-06).
--
-- The owner switches on `require_mfa`; while it is on, a team member whose session has not passed a second step is
-- refused `pay.merchant_mfa_required` on every merchantOps call, so the portal sends them to enrol. Default off: existing
-- merchants keep today's behaviour. Who changed it last and when are kept on the row. Not money.

ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "require_mfa" boolean NOT NULL DEFAULT false;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "require_mfa_changed_by" uuid;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "require_mfa_changed_at" timestamptz;
