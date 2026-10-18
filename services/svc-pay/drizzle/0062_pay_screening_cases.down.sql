-- intafaced:destructive — reversal of 0062_pay_screening_cases.sql
-- Drops screening cases only. Payouts, withdrawals, and ledger rows stay.

DROP TABLE IF EXISTS "pay"."screening_cases";
