-- Reverses 20261124220011_operator_min_notional.sql.
-- intafaced:destructive down migration drops the optional min_notional column added by 20261124220011
ALTER TABLE trade.operator_risk_limits
  DROP COLUMN IF EXISTS min_notional;
