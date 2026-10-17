-- intafaced:destructive — reversal of 0056_pay_metrics_dirty_triggers.sql
--
-- Removes the dirty-marking triggers and their functions. Source rows are not
-- touched. Marks already written are dropped with 0055's tables.
DROP TRIGGER IF EXISTS "checkout_sessions_metrics_dirty_trg" ON "pay"."checkout_sessions";
DROP TRIGGER IF EXISTS "settlements_metrics_dirty_trg" ON "pay"."settlements";
DROP TRIGGER IF EXISTS "payment_events_metrics_dirty_trg" ON "pay"."payment_events";
DROP TRIGGER IF EXISTS "payments_metrics_dirty_trg" ON "pay"."payments";
DROP FUNCTION IF EXISTS "pay"."metrics_sessions_trg"();
DROP FUNCTION IF EXISTS "pay"."metrics_settlements_trg"();
DROP FUNCTION IF EXISTS "pay"."metrics_events_trg"();
DROP FUNCTION IF EXISTS "pay"."metrics_payments_trg"();
DROP FUNCTION IF EXISTS "pay"."metrics_mark"(uuid, timestamptz);
