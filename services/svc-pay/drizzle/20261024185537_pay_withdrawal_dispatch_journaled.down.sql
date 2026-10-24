-- Reverses 20261024185537_pay_withdrawal_dispatch_journaled.sql. The column is a proof marker, not a balance: dropping it only
-- makes every held withdrawal uncancellable again, as before.

ALTER TABLE pay.withdrawals DROP COLUMN IF EXISTS dispatch_journaled;
