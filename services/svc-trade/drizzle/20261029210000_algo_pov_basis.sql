-- trade.algo · POV participation basis: traded volume (default) or opposite-side liquidity
-- Reversal: 20261029210000_algo_pov_basis.down.sql

ALTER TABLE "trade"."algo_parents"
  ADD COLUMN IF NOT EXISTS "pov_basis" text;

ALTER TABLE "trade"."algo_parents"
  DROP CONSTRAINT IF EXISTS "algo_parents_pov_basis_ck";

ALTER TABLE "trade"."algo_parents"
  ADD CONSTRAINT "algo_parents_pov_basis_ck"
  CHECK (
    "pov_basis" IS NULL
    OR ("kind" = 'pov' AND "pov_basis" IN ('traded_volume', 'opposite_liquidity'))
  );
