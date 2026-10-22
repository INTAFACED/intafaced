-- intafaced:destructive — reversal of 0121_pay_merchant_require_mfa.sql
--
-- Drops the team-wide two-step rule. Members are no longer refused for a session without a second step.

ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "require_mfa_changed_at";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "require_mfa_changed_by";
ALTER TABLE "pay"."merchants" DROP COLUMN IF EXISTS "require_mfa";
