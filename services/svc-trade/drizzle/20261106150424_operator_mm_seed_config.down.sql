ALTER TABLE trade.operator_mm_seed
  DROP COLUMN IF EXISTS configured_mid,
  DROP COLUMN IF EXISTS mid_source,
  DROP COLUMN IF EXISTS qty_per_level,
  DROP COLUMN IF EXISTS levels,
  DROP COLUMN IF EXISTS step_bps,
  DROP COLUMN IF EXISTS half_spread_bps;
