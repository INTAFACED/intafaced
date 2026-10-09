-- intafaced:destructive — reversal of 0020_pay_payments_amount_frozen.sql
--
-- Drops the trigger that refuses a change to payments.amount, and the
-- function that trigger calls. The payments table and the amount column stay.
-- Captured and refunded totals stay summed from payment_events.

DROP TRIGGER IF EXISTS "payments_amount_frozen_trg" ON "pay"."payments";
DROP FUNCTION IF EXISTS "pay"."payments_amount_frozen"();
