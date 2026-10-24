-- Reverses 20261024075545_p2p_non_instant_methods.sql.
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_settlement_ck";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "settlement_window_seconds";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "non_instant";
ALTER TABLE "p2p"."offers" DROP COLUMN IF EXISTS "accepts_non_instant";
ALTER TABLE "p2p"."payment_method_schemas" DROP CONSTRAINT IF EXISTS "payment_method_schemas_settlement_ck";
ALTER TABLE "p2p"."payment_method_schemas" DROP COLUMN IF EXISTS "settlement_window_seconds";
ALTER TABLE "p2p"."payment_method_schemas" DROP COLUMN IF EXISTS "instant";
