-- trade.futures_adl_pairs · a planned pair whose positions moved before its loss leg posted is abandoned
-- Reversal: 0079_futures_adl_pair_abandoned.down.sql
--
-- A funding period frozen before an ADL pair was planned can still post against either position. The
-- driver compares the ledger collateral with the plan before the loss leg posts; when it no longer
-- matches, nothing has posted, so the pair is marked `abandoned` (it holds neither position) and the
-- next tick plans again from the moved rows. Identity only, never a balance.

ALTER TABLE "trade"."futures_adl_pairs"
  ADD COLUMN IF NOT EXISTS "abandoned_at" timestamptz;

ALTER TABLE "trade"."futures_adl_pairs" DROP CONSTRAINT IF EXISTS "futures_adl_pairs_state_ck";
ALTER TABLE "trade"."futures_adl_pairs"
  ADD CONSTRAINT "futures_adl_pairs_state_ck" CHECK ("state" IN ('planned', 'applied', 'abandoned'));

ALTER TABLE "trade"."futures_adl_pairs" DROP CONSTRAINT IF EXISTS "futures_adl_pairs_abandoned_at_ck";
ALTER TABLE "trade"."futures_adl_pairs"
  ADD CONSTRAINT "futures_adl_pairs_abandoned_at_ck" CHECK (("state" = 'abandoned') = ("abandoned_at" IS NOT NULL));
