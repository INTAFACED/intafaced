-- intafaced:destructive — reversal of 0104_operator_price_range.sql
-- Drops the dynamic price range: the three operator values and the band records. The static band stays in force.
DROP TABLE IF EXISTS trade.futures_price_band_changes;
DROP TABLE IF EXISTS trade.futures_price_band_current;
ALTER TABLE trade.operator_risk_limits
  DROP COLUMN IF EXISTS price_range_cadence_seconds,
  DROP COLUMN IF EXISTS price_range_trigger,
  DROP COLUMN IF EXISTS price_range_max;
