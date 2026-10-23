-- P-disputes-security-15: maker verification tier at create.
-- A buy ad's buyer is the maker. A later seller fill uses this tier.
-- Null means it was never stored, not that the buyer is uncapped.
-- Reversal: 0019_p2p_maker_verification_tier.down.sql

ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "maker_tier" text;

ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_maker_tier_ck";
ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_maker_tier_ck"
  CHECK ("maker_tier" IS NULL OR "maker_tier" IN ('none', 'basic', 'full', 'institutional'));
