-- trade · paying a spot fee in the platform token (RC-cex-spot-11, J-cex-spot-10 #9)
-- Reversal: 20261025013000_fee_in_platform_token.down.sql
--
-- An order that asked to pay its fees in the token keeps that choice and the stake discount it was placed at, as it
-- keeps its schedule version and fee tier: a stake change or a new decay ladder after placement never re-prices it.
-- Both are null on every other order, and on every order before this migration.
ALTER TABLE "trade"."orders"
  ADD COLUMN IF NOT EXISTS "fee_currency" text,
  ADD COLUMN IF NOT EXISTS "fee_ifc_discount_bps" integer;
ALTER TABLE "trade"."orders"
  DROP CONSTRAINT IF EXISTS "orders_fee_currency_ck",
  ADD CONSTRAINT "orders_fee_currency_ck" CHECK (
    ("fee_currency" IS NULL AND "fee_ifc_discount_bps" IS NULL)
    OR ("fee_currency" ~ '^[A-Z0-9]{2,12}$' AND "fee_ifc_discount_bps" BETWEEN 0 AND 9999)
  ) NOT VALID;
-- NOT VALID: every row before this migration has both columns null, which the check accepts.

-- A leg whose order chose the token but paid in the asset it received says why (trade.fee_ifc_insufficient and the
-- other fallbacks in fee-ifc.ts). A leg that paid in the token names it in fee_asset, as every leg names its fee asset.
ALTER TABLE "trade"."fills" ADD COLUMN IF NOT EXISTS "fee_fallback" text;
ALTER TABLE "trade"."fills"
  DROP CONSTRAINT IF EXISTS "fills_fee_fallback_ck",
  ADD CONSTRAINT "fills_fee_fallback_ck" CHECK ("fee_fallback" IS NULL OR "fee_fallback" ~ '^trade\.fee_ifc_[a-z_]{1,40}$') NOT VALID;
