-- intafaced:destructive — reversal of 0057_pay_metrics_indexes.sql
--
-- Drops two indexes. No rows are touched.
DROP INDEX IF EXISTS "pay"."settlements_metrics_created_idx";
DROP INDEX IF EXISTS "pay"."payment_events_metrics_ts_idx";
