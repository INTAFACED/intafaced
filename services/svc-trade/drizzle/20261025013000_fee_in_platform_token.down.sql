-- intafaced:destructive — reversal of 20261025013000_fee_in_platform_token.sql; drops each order's fee currency choice and stake discount and each fill's fee fallback reason (fills paid in the token keep fee_asset and fee_amount)
ALTER TABLE "trade"."fills"
  DROP CONSTRAINT IF EXISTS "fills_fee_fallback_ck",
  DROP COLUMN IF EXISTS "fee_fallback";
ALTER TABLE "trade"."orders"
  DROP CONSTRAINT IF EXISTS "orders_fee_currency_ck",
  DROP COLUMN IF EXISTS "fee_currency",
  DROP COLUMN IF EXISTS "fee_ifc_discount_bps";
