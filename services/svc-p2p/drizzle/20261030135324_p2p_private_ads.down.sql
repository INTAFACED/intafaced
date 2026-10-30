-- Reverses 20261030135324_p2p_private_ads.sql. Every ad becomes public again; share links and which orders came through one go.
DROP TRIGGER IF EXISTS "p2p_trades_shared_from_fixed_trg" ON "p2p"."p2p_trades";
DROP FUNCTION IF EXISTS "p2p"."p2p_trades_shared_from_fixed"();
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "shared_from";
DROP TABLE IF EXISTS "p2p"."offer_share_links";
ALTER TABLE "p2p"."offers" DROP CONSTRAINT IF EXISTS "offers_visibility_ck";
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "visibility";
