-- Reverses 20261106120000_p2p_ad_release_window.sql. Every ad and order goes back to the owner's published release clock.
DROP TRIGGER IF EXISTS "p2p_trades_release_window_fixed_trg" ON "p2p"."p2p_trades";
DROP FUNCTION IF EXISTS "p2p"."p2p_trades_release_window_fixed"();
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_release_window_ck";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "release_window_seconds";
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_release_window_ck";
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "release_window_seconds";
