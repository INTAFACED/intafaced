-- card_conversions.funding_amount is the scaled ceiling of settlement_amount / rate.
--
-- 0007 says funding_amount is the ceil of settlement / rate, and only checks
-- that settlement_amount, funding_amount, and rate are positive. A frozen
-- quote can disagree with the recorded rate and still store.
--
-- The ceiling is the one fundingFor already uses, at 18 decimal places:
--   ceil(settlement_amount * 10^18 / rate) / 10^18.
-- A whole-unit ceil(settlement_amount / rate) is a different number and would
-- reject a real quote.
--
-- CHECK only. No UPDATE, no DELETE, and no INSERT. If a stored row already
-- disagrees, ADD CONSTRAINT fails and that row stays.
--
-- Reversal: 0027_card_conversion_funding_ceil.down.sql

ALTER TABLE "bank"."card_conversions" DROP CONSTRAINT IF EXISTS "card_conversions_funding_ceil";
ALTER TABLE "bank"."card_conversions" ADD CONSTRAINT "card_conversions_funding_ceil"
  CHECK (
    "funding_amount" = ceil("settlement_amount" * 1000000000000000000 / "rate") / 1000000000000000000
  );
