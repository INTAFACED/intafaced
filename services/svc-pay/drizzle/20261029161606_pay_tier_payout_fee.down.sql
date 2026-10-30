-- intafaced:destructive — reversal of 20261029161606_pay_tier_payout_fee.sql
--
-- Drops the published payout fee from every tier. Merchants read "Not set"
-- again. No payout or ledger row changes, since no payout fee was ever charged.

ALTER TABLE "pay"."control_tiers"
  DROP CONSTRAINT IF EXISTS "control_tiers_payout_fee_known";

ALTER TABLE "pay"."control_tiers"
  DROP COLUMN IF EXISTS "payout_fee";
