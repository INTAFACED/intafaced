-- intafaced:destructive — reversal of 0103_operator_oi_limits.sql
-- Drops the two open-interest limit columns. Only those limit values are lost; the other operator limits are untouched.
ALTER TABLE trade.operator_risk_limits DROP COLUMN IF EXISTS oi_share_bps, DROP COLUMN IF EXISTS oi_limit;
