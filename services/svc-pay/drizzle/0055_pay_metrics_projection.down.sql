-- intafaced:destructive — reversal of 0055_pay_metrics_projection.sql
--
-- Drops the metrics projection tables and the dirty log. They hold derived data
-- only; every row is recomputed from the payment, event and settlement tables.
DROP TABLE IF EXISTS "pay"."metrics_merchant_day_link";
DROP TABLE IF EXISTS "pay"."metrics_merchant_day_status";
DROP TABLE IF EXISTS "pay"."metrics_merchant_day";
DROP TABLE IF EXISTS "pay"."metrics_dirty";
