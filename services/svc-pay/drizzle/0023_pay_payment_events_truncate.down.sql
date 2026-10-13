-- intafaced:destructive — reversal of 0023_pay_payment_events_truncate.sql
--
-- Drops the BEFORE TRUNCATE statement trigger on pay.payment_events.
-- The append-only function and the BEFORE UPDATE OR DELETE row trigger stay.
-- Stored payment_events rows stay.

DROP TRIGGER IF EXISTS "payment_events_append_only_truncate_trg" ON "pay"."payment_events";
