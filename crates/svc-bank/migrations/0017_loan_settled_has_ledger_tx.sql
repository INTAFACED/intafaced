-- Settled loan movements must point at a ledger transaction.
--
-- `transfer_executions_settled_has_tx_ck` has said this since the initial
-- schema: a settled row with no ledger transaction id is a claim that money
-- moved with nothing in the book to point at. `loan_collateral_events`,
-- `loan_repayments`, and `loan_liquidations` could still take that shape.
--
-- A liquidation shortfall above zero is principal the sale did not cover,
-- booked by `loanBadDebt`. A null `bad_debt_ledger_tx_id` on that row is the
-- same phantom, settled or not. The claim is inserted with shortfall 0; the
-- figure and the bad-debt transaction id are written together, once, before
-- the rung is marked settled.
--
-- CHECK constraints only. No UPDATE and no DELETE of money rows. If a book
-- already holds a violating row, ADD CONSTRAINT fails and the amounts stay
-- as they are.

ALTER TABLE "bank"."loan_collateral_events" DROP CONSTRAINT IF EXISTS "loan_collateral_events_settled_has_tx_ck";
ALTER TABLE "bank"."loan_collateral_events" ADD CONSTRAINT "loan_collateral_events_settled_has_tx_ck"
  CHECK ("status" <> 'settled' OR ("ledger_tx_id" IS NOT NULL AND "settled_at" IS NOT NULL));

ALTER TABLE "bank"."loan_repayments" DROP CONSTRAINT IF EXISTS "loan_repayments_settled_has_tx_ck";
ALTER TABLE "bank"."loan_repayments" ADD CONSTRAINT "loan_repayments_settled_has_tx_ck"
  CHECK ("status" <> 'settled' OR ("ledger_tx_id" IS NOT NULL AND "settled_at" IS NOT NULL));

ALTER TABLE "bank"."loan_liquidations" DROP CONSTRAINT IF EXISTS "loan_liquidations_settled_has_tx_ck";
ALTER TABLE "bank"."loan_liquidations" ADD CONSTRAINT "loan_liquidations_settled_has_tx_ck"
  CHECK ("status" <> 'settled' OR ("ledger_tx_id" IS NOT NULL AND "settled_at" IS NOT NULL));

ALTER TABLE "bank"."loan_liquidations" DROP CONSTRAINT IF EXISTS "loan_liquidations_shortfall_has_bad_debt_tx_ck";
ALTER TABLE "bank"."loan_liquidations" ADD CONSTRAINT "loan_liquidations_shortfall_has_bad_debt_tx_ck"
  CHECK ("shortfall" = 0 OR "bad_debt_ledger_tx_id" IS NOT NULL);
