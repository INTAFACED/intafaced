-- intafaced:destructive — reversal of 20261024193000_fill_maker_rebate.sql; drops the rebate record on fills (the ledger keeps every paid rebate)
ALTER TABLE "trade"."fills"
  DROP CONSTRAINT IF EXISTS "fills_maker_rebate_ck",
  DROP COLUMN IF EXISTS "rebate_asset",
  DROP COLUMN IF EXISTS "rebate_amount",
  DROP COLUMN IF EXISTS "rebate_bps";
