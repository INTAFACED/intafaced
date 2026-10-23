-- intafaced:destructive — reversal of 0098_chart_owner_values.sql
-- Drops the charts owner-value snapshots and the per-market data class history. Nothing else depends on them.
DROP TABLE IF EXISTS "trade"."chart_data_class";
DROP TABLE IF EXISTS "trade"."chart_owner_values";
