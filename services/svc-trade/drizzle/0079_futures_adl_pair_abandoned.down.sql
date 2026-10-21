-- intafaced:destructive — reversal of 0079_futures_adl_pair_abandoned.sql
-- Abandoned pairs keep their rows (their keys never posted); the narrower state check is added NOT VALID
-- so those rows stay readable for audit.
ALTER TABLE "trade"."futures_adl_pairs" DROP CONSTRAINT IF EXISTS "futures_adl_pairs_abandoned_at_ck";
ALTER TABLE "trade"."futures_adl_pairs" DROP CONSTRAINT IF EXISTS "futures_adl_pairs_state_ck";
ALTER TABLE "trade"."futures_adl_pairs"
  ADD CONSTRAINT "futures_adl_pairs_state_ck" CHECK ("state" IN ('planned', 'applied')) NOT VALID;
ALTER TABLE "trade"."futures_adl_pairs" DROP COLUMN IF EXISTS "abandoned_at";
