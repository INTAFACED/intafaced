-- P-trade-orders-15 (J-p2p-06 #5): an ad's own release window. No balance is stored here.
--
-- `offers.release_window_seconds`: how long the seller of this ad has, once the buyer marks paid, before the release
-- timeout opens a dispute. Null keeps the owner's published release clock (P2P_RELEASE_DEADLINE_SECONDS). The service
-- refuses a value outside 60 s and that published clock, so an ad can shorten the clock, never lengthen it.
-- `p2p_trades.release_window_seconds`: the ad's window copied at take, written once and never changed, so a later ad
-- edit cannot move an order's clock.
-- Reversal: 20261106120000_p2p_ad_release_window.down.sql
ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "release_window_seconds" integer;
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_release_window_ck";
ALTER TABLE "p2p"."offers" ADD CONSTRAINT "offers_release_window_ck"
  CHECK ("release_window_seconds" IS NULL OR "release_window_seconds" >= 60);

ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "release_window_seconds" integer;
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_release_window_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_release_window_ck"
  CHECK ("release_window_seconds" IS NULL OR "release_window_seconds" >= 60);
CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_release_window_fixed"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."release_window_seconds" IS DISTINCT FROM OLD."release_window_seconds" THEN
    RAISE EXCEPTION 'p2p_trades.release_window_seconds is written once at take';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS "p2p_trades_release_window_fixed_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_release_window_fixed_trg" BEFORE UPDATE OF "release_window_seconds" ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_release_window_fixed"();
