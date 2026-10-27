-- Reverses 20261025020000_p2p_method_rules.sql. Orders paid in cash then take the published release deadline.
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_cash_release_ck";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "cash_release_seconds";
ALTER TABLE "p2p"."payment_method_schemas" DROP CONSTRAINT IF EXISTS "payment_method_schemas_cash_rules_ck";
ALTER TABLE "p2p"."payment_method_schemas" DROP CONSTRAINT IF EXISTS "payment_method_schemas_note_rules_ck";
ALTER TABLE "p2p"."payment_method_schemas" DROP COLUMN IF EXISTS "cash_rules";
ALTER TABLE "p2p"."payment_method_schemas" DROP COLUMN IF EXISTS "note_rules";
