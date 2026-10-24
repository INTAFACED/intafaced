-- intafaced:destructive — reversal of 20261024171500_order_bracket_intent_oto.sql
-- An OTO row has no stop-loss, so it cannot stay in a bracket-only table: OTO intents are deleted first.
DELETE FROM "trade"."order_bracket_intent" WHERE "kind" = 'oto';

ALTER TABLE "trade"."order_bracket_intent"
  DROP CONSTRAINT IF EXISTS "order_bracket_intent_kind_ck",
  ALTER COLUMN "stop_loss" SET NOT NULL,
  DROP COLUMN IF EXISTS "kind",
  ADD CONSTRAINT "order_bracket_intent_positive_ck" CHECK ("take_profit" > 0 AND "stop_loss" > 0);
