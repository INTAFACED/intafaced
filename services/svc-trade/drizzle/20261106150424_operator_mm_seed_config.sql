-- J-cex-spot-20 #5 (RC-cex-spot-17): the internal book seeding configuration is operator-written. Each version of a
-- market's seed row now carries the whole configuration the seed job places from, under the same two-person approval.
-- A row written before this (the on/off switch alone) has these blank: the job reads it as `mm.seed_unset` and places
-- nothing for that market. Append-only, as before.
ALTER TABLE trade.operator_mm_seed
  ADD COLUMN IF NOT EXISTS half_spread_bps integer CHECK (half_spread_bps IS NULL OR half_spread_bps > 0),
  ADD COLUMN IF NOT EXISTS step_bps integer CHECK (step_bps IS NULL OR step_bps > 0),
  ADD COLUMN IF NOT EXISTS levels integer CHECK (levels IS NULL OR (levels >= 1 AND levels <= 20)),
  ADD COLUMN IF NOT EXISTS qty_per_level numeric(38, 18) CHECK (qty_per_level IS NULL OR qty_per_level > 0),
  ADD COLUMN IF NOT EXISTS mid_source text CHECK (mid_source IS NULL OR mid_source IN ('configured', 'venue')),
  ADD COLUMN IF NOT EXISTS configured_mid numeric(38, 18) CHECK (configured_mid IS NULL OR configured_mid > 0);
