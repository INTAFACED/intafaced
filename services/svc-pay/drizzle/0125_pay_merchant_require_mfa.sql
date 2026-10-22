-- TEAM-WIDE TWO-STEP SIGN-IN RULE (M-plat-org-06, org-access-019): the svc-pay half.
--
-- `require_mfa` is the owner's choice and has no default: NULL means the owner has not chosen, and every read of the
-- rule refuses `pay.merchant_mfa_rule_unset` until they do. `require_mfa_revision` counts the owner's changes so a
-- change against a stale screen is refused. svc-identity reads the rule over S2S and enforces it at sign-in (follow-up
-- slice half); nothing in svc-pay gates a call on it. Not money.

ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "require_mfa" boolean;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "require_mfa_revision" integer NOT NULL DEFAULT 0
  CONSTRAINT "merchants_require_mfa_revision_nonneg" CHECK ("require_mfa_revision" >= 0);
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "require_mfa_changed_by" uuid;
ALTER TABLE "pay"."merchants" ADD COLUMN IF NOT EXISTS "require_mfa_changed_at" timestamptz;
