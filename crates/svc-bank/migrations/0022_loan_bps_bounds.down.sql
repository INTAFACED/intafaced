-- Restore the 0002 checks. The forward migration rewrote no row, so dropping
-- the tightened checks and putting the previous ones back returns the table
-- to the shape it had before.

ALTER TABLE "bank"."loan_products" DROP CONSTRAINT IF EXISTS "loan_products_ltv_ordered";

ALTER TABLE "bank"."loan_products" ADD CONSTRAINT "loan_products_ltv_ordered" CHECK (
  "max_ltv_bps" > 0
  AND "target_ltv_bps" < "margin_call_ltv_bps"
  AND "max_ltv_bps" < "margin_call_ltv_bps"
  AND "margin_call_ltv_bps" < "liquidation_ltv_bps"
  AND "liquidation_ltv_bps" <= "insolvency_ltv_bps"
);

ALTER TABLE "bank"."loan_products" DROP CONSTRAINT IF EXISTS "loan_products_bps_bounded";

ALTER TABLE "bank"."loan_products" ADD CONSTRAINT "loan_products_bps_bounded" CHECK (
  "apr_bps" >= 0
  AND "penalty_bps" >= 0 AND "penalty_bps" <= 10000
  AND "max_tranche_bps" > 0 AND "max_tranche_bps" <= 10000
  AND "grace_seconds" >= 0
);
