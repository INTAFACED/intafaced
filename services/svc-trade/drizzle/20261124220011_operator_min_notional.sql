-- Minimum order value per market on the operator's versioned, four-eyes limits row (J-cex-spot-04 #6).
-- Blank is NULL: "not set", and an order on a market whose owner has not published a minimum refuses
-- trade.min_notional_unset rather than defaulting. Rows stay append-only (0055).
-- Reversal: 20261124220011_operator_min_notional.down.sql
ALTER TABLE trade.operator_risk_limits
  ADD COLUMN IF NOT EXISTS min_notional text;
