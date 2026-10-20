-- intafaced:destructive — reversal of 0080_funding_rate_engine.sql
DROP TABLE IF EXISTS "trade"."funding_rate_periods";
DROP FUNCTION IF EXISTS trade.funding_rate_period_closed();
DROP TABLE IF EXISTS "trade"."funding_rate_samples";
DROP TABLE IF EXISTS "trade"."funding_index_sources";
DROP TABLE IF EXISTS "trade"."funding_params";
