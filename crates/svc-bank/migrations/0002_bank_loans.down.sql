-- Reversal of 0002_bank_loans.
--
-- intafaced:destructive — dropping these tables destroys the loan audit trail:
-- every interest accrual, every margin call, every liquidation rung and their
-- ledger transaction ids. The LEDGER keeps the money history regardless (that is
-- the point of §0.6), so no value is lost and no balance changes. What is lost is
-- the ability to say WHY a given posting happened — which day's interest, which
-- rung of which ladder.
--
-- So: this reversal is for an unwind on a branch, before any real loan exists.
-- Rolling 0002 back on a database with live loans is an operator decision that
-- needs the tables exported first, and there is no version of it that is routine.
--
-- Dropped in reverse dependency order; every table here references `loans`.

DROP TABLE IF EXISTS "bank"."loan_liquidations";
DROP TABLE IF EXISTS "bank"."loan_margin_calls";
DROP TABLE IF EXISTS "bank"."loan_repayments";
DROP TABLE IF EXISTS "bank"."loan_interest_accruals";
DROP TABLE IF EXISTS "bank"."loan_collateral_events";
DROP TABLE IF EXISTS "bank"."loans";
DROP TABLE IF EXISTS "bank"."loan_products";

DROP TYPE IF EXISTS "bank"."loan_event_status";
DROP TYPE IF EXISTS "bank"."collateral_direction";
DROP TYPE IF EXISTS "bank"."loan_status";
