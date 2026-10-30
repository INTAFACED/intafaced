-- M-money-out-06: the payout fee a tier publishes to merchants.
-- Reversal: 20261029161606_pay_tier_payout_fee.down.sql
--
-- NULL on every existing tier: nothing is published until two founders upsert
-- the tier with a payout fee, and a merchant reads NULL as "Not set", never as
-- free. The only kind today is {"kind":"not_charged"}, because svc-pay takes
-- no fee on a payout (payment-service/payouts.ts). A charged kind is added by
-- replacing this check in the same change that starts charging it.

ALTER TABLE "pay"."control_tiers"
  ADD COLUMN IF NOT EXISTS "payout_fee" jsonb;

ALTER TABLE "pay"."control_tiers"
  DROP CONSTRAINT IF EXISTS "control_tiers_payout_fee_known";

ALTER TABLE "pay"."control_tiers"
  ADD CONSTRAINT "control_tiers_payout_fee_known"
  CHECK ("payout_fee" IS NULL OR "payout_fee" = '{"kind": "not_charged"}'::jsonb);
