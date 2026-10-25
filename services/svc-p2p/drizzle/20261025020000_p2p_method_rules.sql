-- P-ads-merchant-19: cash-in-person rules and payment-note rules on the method row, and the cash release window an order
-- copies at take.
-- A method row may carry payment-note rules (guidance for the note, words that never go in it) and cash-in-person rules
-- (meeting and proof guidance, the seller's release window). Rules make the method cash in person: a floating ad cannot
-- list it, and an order paid with it takes the row's release window, copied at take like the settlement profile.
-- No balance is stored here.
-- Reversal: 20261025020000_p2p_method_rules.down.sql
ALTER TABLE "p2p"."payment_method_schemas" ADD COLUMN IF NOT EXISTS "note_rules" jsonb;
ALTER TABLE "p2p"."payment_method_schemas" ADD COLUMN IF NOT EXISTS "cash_rules" jsonb;
ALTER TABLE "p2p"."payment_method_schemas" DROP CONSTRAINT IF EXISTS "payment_method_schemas_note_rules_ck";
ALTER TABLE "p2p"."payment_method_schemas" ADD CONSTRAINT "payment_method_schemas_note_rules_ck"
  CHECK (
    "note_rules" IS NULL
    OR (jsonb_typeof("note_rules"->'guidance') = 'string' AND jsonb_typeof("note_rules"->'forbidden') = 'array')
  );
ALTER TABLE "p2p"."payment_method_schemas" DROP CONSTRAINT IF EXISTS "payment_method_schemas_cash_rules_ck";
ALTER TABLE "p2p"."payment_method_schemas" ADD CONSTRAINT "payment_method_schemas_cash_rules_ck"
  CHECK (
    "cash_rules" IS NULL
    OR (
      jsonb_typeof("cash_rules"->'meetingGuidance') = 'string'
      AND jsonb_typeof("cash_rules"->'proof') = 'string'
      AND jsonb_typeof("cash_rules"->'releaseWindowSeconds') = 'number'
      AND ("cash_rules"->>'releaseWindowSeconds')::numeric BETWEEN 300 AND 86400
    )
  );

ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "cash_release_seconds" integer;
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_cash_release_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_cash_release_ck"
  CHECK ("cash_release_seconds" IS NULL OR "cash_release_seconds" BETWEEN 300 AND 86400);
