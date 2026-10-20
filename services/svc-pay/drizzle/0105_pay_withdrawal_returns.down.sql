-- intafaced:destructive — reversal of 0105_pay_withdrawal_returns.sql
--
-- Drops the recorded returned withdrawals and their history. Nothing was booked for them (no returned-funds recipe
-- exists), so no balance lives here; this is for CI proof of reversibility and a database that recorded no real return.

DROP TRIGGER IF EXISTS "withdrawal_returns_append_only_trg" ON "pay"."withdrawal_returns";
DROP TRIGGER IF EXISTS "withdrawal_return_events_append_only_trg" ON "pay"."withdrawal_return_events";
DROP FUNCTION IF EXISTS "pay"."withdrawal_returns_append_only"();
DROP INDEX IF EXISTS "pay"."withdrawal_return_events_subject_idx";
DROP TABLE IF EXISTS "pay"."withdrawal_return_events";
DROP INDEX IF EXISTS "pay"."withdrawal_returns_recorded_idx";
DROP INDEX IF EXISTS "pay"."withdrawal_returns_ref_uq";
DROP TABLE IF EXISTS "pay"."withdrawal_returns";
