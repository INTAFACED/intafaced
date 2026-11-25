DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."card_conversions" WHERE "rate_quality" = 'partner') THEN
    RAISE EXCEPTION 'card_conversions holds partner rates (J-bank-29); rolling back would orphan them';
  END IF;
END $$;
ALTER TABLE "bank"."card_conversions" DROP CONSTRAINT IF EXISTS "card_conversions_assets_differ";
ALTER TABLE "bank"."card_conversions" ADD CONSTRAINT "card_conversions_assets_differ" CHECK ("settlement_asset_id" <> "funding_asset_id");
ALTER TABLE "bank"."card_conversions" DROP CONSTRAINT IF EXISTS "card_conversions_quality_known";
ALTER TABLE "bank"."card_conversions" ADD CONSTRAINT "card_conversions_quality_known"
  CHECK ("rate_quality" IN ('mid', 'index', 'last'));
ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_pay_from_order_partner";
ALTER TABLE "bank"."card_authorizations" DROP COLUMN IF EXISTS "pay_from_order";
