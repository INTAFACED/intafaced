-- intafaced:destructive — reversal of 0078_futures_families_schedule_premarket.sql
-- Drops the family and settle-asset columns, the owner expiry-tenor table and the pre-market params table.
-- Futures rows keep every other term; family and settle asset are re-derivable (linear, quote asset).
ALTER TABLE "trade"."markets" DROP CONSTRAINT IF EXISTS "markets_futures_family_terms_ck";

ALTER TABLE "trade"."markets"
  DROP COLUMN IF EXISTS "futures_settle_asset",
  DROP COLUMN IF EXISTS "futures_family";

DROP TYPE IF EXISTS "trade"."futures_family";

DROP TABLE IF EXISTS "trade"."operator_premarket_params";
DROP TABLE IF EXISTS "trade"."futures_expiry_schedule";
