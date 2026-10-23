-- Open-interest limits per futures market (D-margin-05, J-derivatives-02 #7), on the operator's versioned, four-eyes
-- limits row. oi_limit is the market's largest open interest in its base asset (the sum of open position sizes, as the
-- ticker counts it); oi_share_bps is the largest share of that limit one account may hold, in basis points. Blank is
-- NULL: "not set", and a futures open on a market with either blank refuses (trade.oi_limit_unset), never unlimited.
-- Spot markets carry the columns and never read them. Rows stay append-only (0055).
-- Reversal: 0103_operator_oi_limits.down.sql
ALTER TABLE trade.operator_risk_limits
  ADD COLUMN IF NOT EXISTS oi_limit text,
  ADD COLUMN IF NOT EXISTS oi_share_bps text;
