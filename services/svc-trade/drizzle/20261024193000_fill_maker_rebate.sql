-- trade.fills · the maker rebate a maker leg earned (SP-fees-vip-01, J-cex-spot-10 #4)
-- Reversal: 20261024193000_fill_maker_rebate.down.sql
--
-- A rebate is never a negative fee: the maker leg keeps its fee (0) and says what it was paid back, at what rate and in
-- which asset. The ledger pays it under trade.fill.rebate:<fillId> from the same fill's taker fee. All three are set
-- together or none is; a taker leg never carries one.

ALTER TABLE "trade"."fills"
  ADD COLUMN IF NOT EXISTS "rebate_bps" integer,
  ADD COLUMN IF NOT EXISTS "rebate_amount" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "rebate_asset" text;

ALTER TABLE "trade"."fills"
  DROP CONSTRAINT IF EXISTS "fills_maker_rebate_ck",
  ADD CONSTRAINT "fills_maker_rebate_ck" CHECK (
    ("rebate_bps" IS NULL AND "rebate_amount" IS NULL AND "rebate_asset" IS NULL)
    OR ("liquidity" = 'maker' AND "fee_amount" = 0 AND "rebate_bps" > 0 AND "rebate_amount" > 0 AND "rebate_asset" IS NOT NULL)
  );
