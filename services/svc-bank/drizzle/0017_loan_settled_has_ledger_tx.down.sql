ALTER TABLE "bank"."loan_liquidations" DROP CONSTRAINT IF EXISTS "loan_liquidations_shortfall_has_bad_debt_tx_ck";
ALTER TABLE "bank"."loan_liquidations" DROP CONSTRAINT IF EXISTS "loan_liquidations_settled_has_tx_ck";
ALTER TABLE "bank"."loan_repayments" DROP CONSTRAINT IF EXISTS "loan_repayments_settled_has_tx_ck";
ALTER TABLE "bank"."loan_collateral_events" DROP CONSTRAINT IF EXISTS "loan_collateral_events_settled_has_tx_ck";
