-- card_conversions.funding_amount is the smallest numeric(38,18) that is at
-- least settlement_amount / rate, the same value as div(settlement, rate, 'ceil').
--
-- 0007 says funding_amount is the ceil of settlement / rate, and only checks
-- that settlement_amount, funding_amount, and rate are positive. A frozen
-- quote can disagree with the recorded rate and still store.
--
-- A whole-unit ceil(settlement_amount / rate) is a different number and would
-- reject a real quote. The check does not divide: numeric division rounds to
-- 18 fractional digits before ceil, so a rounded quotient is not that ceiling.
--   funding_amount * rate >= settlement_amount
--   AND (funding_amount * 10^18 - 1) * rate < settlement_amount * 10^18
--
-- CHECK only. No UPDATE, no DELETE, and no INSERT. If a stored row already
-- disagrees, ADD CONSTRAINT fails and that row stays.
--
-- Reversal: 0027_card_conversion_funding_ceil.down.sql

ALTER TABLE "bank"."card_conversions" DROP CONSTRAINT IF EXISTS "card_conversions_funding_ceil";
ALTER TABLE "bank"."card_conversions" ADD CONSTRAINT "card_conversions_funding_ceil"
  CHECK (
    "funding_amount" * "rate" >= "settlement_amount"
    AND ("funding_amount" * 1000000000000000000 - 1) * "rate" < "settlement_amount" * 1000000000000000000
  );
