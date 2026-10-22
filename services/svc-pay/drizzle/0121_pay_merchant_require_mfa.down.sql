-- intafaced:destructive — reversal of 0121_pay_merchant_require_mfa.sql
--
-- Drops the owner's team-wide two-step rule and its change history.

ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "require_mfa_changed_at";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "require_mfa_changed_by";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "require_mfa_revision";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "require_mfa";
