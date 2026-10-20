-- intafaced:destructive — reversal of 0100_pay_withdrawal_limits.sql
--
-- Drops the owner-set withdrawal limits and their audit trail. This deletes
-- history, so it is for CI proof of reversibility and for a database that never
-- held a real change. With the table gone the guard has no limit and refuses.

DROP TRIGGER IF EXISTS "withdrawal_limit_events_append_only_trg" ON "pay"."withdrawal_limit_events";
DROP FUNCTION IF EXISTS "pay"."withdrawal_limit_events_append_only"();
DROP INDEX IF EXISTS "pay"."withdrawal_limit_events_entry_idx";
DROP TABLE IF EXISTS "pay"."withdrawal_limit_events";
DROP TABLE IF EXISTS "pay"."withdrawal_limits";
