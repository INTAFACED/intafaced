-- loan_products.target_ltv_bps can be zero or negative: loan_products_ltv_ordered
-- only requires it below margin_call. loan_products.apr_bps is only checked as
-- >= 0, unlike earn_pools_apr_sane_ck (apr_bps >= 0 AND apr_bps <= 1000000).
-- A negative liquidation stop or an uncapped APR is stored policy.
--
-- A new stop must be above zero. APR stays in [0, 1000000]. The ordering is
-- unchanged. NOT VALID because rows already stored may be the old shape. A
-- validating CHECK would fail this migration on them. New inserts and updates
-- are still refused. This file does not update or delete any row.
--
-- Reversal: 0022_loan_bps_bounds.down.sql

ALTER TABLE "bank"."loan_products" DROP CONSTRAINT IF EXISTS "loan_products_ltv_ordered";

ALTER TABLE "bank"."loan_products"
  ADD CONSTRAINT "loan_products_ltv_ordered"
  CHECK (
    "max_ltv_bps" > 0
    AND "target_ltv_bps" > 0
    AND "target_ltv_bps" < "margin_call_ltv_bps"
    AND "max_ltv_bps" < "margin_call_ltv_bps"
    AND "margin_call_ltv_bps" < "liquidation_ltv_bps"
    AND "liquidation_ltv_bps" <= "insolvency_ltv_bps"
  ) NOT VALID;

ALTER TABLE "bank"."loan_products" DROP CONSTRAINT IF EXISTS "loan_products_bps_bounded";

ALTER TABLE "bank"."loan_products"
  ADD CONSTRAINT "loan_products_bps_bounded"
  CHECK (
    "apr_bps" >= 0 AND "apr_bps" <= 1000000
    AND "penalty_bps" >= 0 AND "penalty_bps" <= 10000
    AND "max_tranche_bps" > 0 AND "max_tranche_bps" <= 10000
    AND "grace_seconds" >= 0
  ) NOT VALID;
