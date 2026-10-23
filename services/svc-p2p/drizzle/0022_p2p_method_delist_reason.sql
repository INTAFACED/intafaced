-- P-trade-orders-03: why a payment method was retired in a market, and when.
-- Written by instruments.methods.setEnabled(false), which requires a reason; cleared when the method is enabled again.
-- A take on a retired method refuses p2p.method_delisted with this reason. No balance is stored here.
-- Reversal: 0022_p2p_method_delist_reason.down.sql
ALTER TABLE "p2p"."payment_method_schemas" ADD COLUMN IF NOT EXISTS "delist_reason" text;
ALTER TABLE "p2p"."payment_method_schemas" ADD COLUMN IF NOT EXISTS "delisted_at" timestamptz;
ALTER TABLE "p2p"."payment_method_schemas" DROP CONSTRAINT IF EXISTS "payment_method_schemas_delist_reason_ck";
ALTER TABLE "p2p"."payment_method_schemas" ADD CONSTRAINT "payment_method_schemas_delist_reason_ck"
  CHECK ("delist_reason" IS NULL OR "delist_reason" IN ('regulation', 'provider_withdrawn', 'fraud_risk', 'low_demand'));
