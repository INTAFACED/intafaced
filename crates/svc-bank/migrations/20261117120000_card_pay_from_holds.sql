-- J-bank-29 #3 to #7 (BK-ccrypto-02, BK-ccrypto-03): a card payment taken by the person's pay-from order. The partner holds
-- it from the first asset in the order that covers it, at its own rate (OWNER 226); the ledger posts nothing.
--
-- `pay_from_order` is the order the partner was asked to walk, as it was sent, so a redelivery re-sends the same
-- instruction under the same key and the decline names the order. Null on every other authorisation, which holds in the
-- card's own asset as before.
ALTER TABLE "bank"."card_authorizations"
  ADD COLUMN IF NOT EXISTS "pay_from_order" text[];

ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_pay_from_order_partner";
ALTER TABLE "bank"."card_authorizations" ADD CONSTRAINT "card_authorizations_pay_from_order_partner"
  CHECK ("pay_from_order" IS NULL OR ("money_book" = 'partner' AND cardinality("pay_from_order") BETWEEN 1 AND 50));

-- The partner's rate, recorded as the partner reported it with its hold: `partner` is a fourth kind of number, beside the
-- market's mid, index and last.
ALTER TABLE "bank"."card_conversions" DROP CONSTRAINT IF EXISTS "card_conversions_quality_known";
ALTER TABLE "bank"."card_conversions" ADD CONSTRAINT "card_conversions_quality_known"
  CHECK ("rate_quality" IN ('mid', 'index', 'last', 'partner'));

-- A pay-from payment held in the asset the card settles in (USDC for a USDC charge) still records the partner's rate (1)
-- and its time, as the partner reported them with the hold; a market conversion between one asset and itself stays refused.
ALTER TABLE "bank"."card_conversions" DROP CONSTRAINT IF EXISTS "card_conversions_assets_differ";
ALTER TABLE "bank"."card_conversions" ADD CONSTRAINT "card_conversions_assets_differ"
  CHECK ("settlement_asset_id" <> "funding_asset_id" OR "rate_quality" = 'partner');
