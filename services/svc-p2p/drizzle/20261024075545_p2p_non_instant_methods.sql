-- P-disputes-security-09: non-instant payment methods.
-- A method row in a market says whether money on it arrives at once or within a settlement window (blank window: the
-- published payment deadline applies). A sell ad consents to non-instant methods at post; a take copies the profile of
-- the market it pays into onto the order, so the payment deadline and the earliest dispute come from it.
-- No balance is stored here.
-- Reversal: 20261024075545_p2p_non_instant_methods.down.sql
ALTER TABLE "p2p"."payment_method_schemas" ADD COLUMN IF NOT EXISTS "instant" boolean NOT NULL DEFAULT true;
ALTER TABLE "p2p"."payment_method_schemas" ADD COLUMN IF NOT EXISTS "settlement_window_seconds" integer;
ALTER TABLE "p2p"."payment_method_schemas" DROP CONSTRAINT IF EXISTS "payment_method_schemas_settlement_ck";
ALTER TABLE "p2p"."payment_method_schemas" ADD CONSTRAINT "payment_method_schemas_settlement_ck"
  CHECK (
    ("instant" AND "settlement_window_seconds" IS NULL)
    OR (NOT "instant" AND ("settlement_window_seconds" IS NULL OR "settlement_window_seconds" BETWEEN 60 AND 2592000))
  );

ALTER TABLE "p2p"."offers" ADD COLUMN IF NOT EXISTS "accepts_non_instant" boolean NOT NULL DEFAULT false;

ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "non_instant" boolean NOT NULL DEFAULT false;
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "settlement_window_seconds" integer;
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_settlement_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_settlement_ck"
  CHECK (
    (NOT "non_instant" AND "settlement_window_seconds" IS NULL)
    OR ("non_instant" AND ("settlement_window_seconds" IS NULL OR "settlement_window_seconds" BETWEEN 60 AND 2592000))
  );
