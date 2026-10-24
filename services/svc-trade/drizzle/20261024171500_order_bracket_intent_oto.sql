-- trade.order_bracket_intent · an OTO: an entry with one attached close, placed when the entry fills (J-cex-spot-08 #10)
-- Reversal: 20261024171500_order_bracket_intent_oto.down.sql
--
-- An OTO is a bracket with one exit: a sell limit at the close price for the base the entry received. It keeps the
-- bracket's crash safety and place grant, so it shares the row. `kind` says which it is; an OTO stores no stop-loss.
-- Every row before this one is a bracket with both prices.

ALTER TABLE "trade"."order_bracket_intent"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'bracket',
  ALTER COLUMN "stop_loss" DROP NOT NULL;

ALTER TABLE "trade"."order_bracket_intent"
  DROP CONSTRAINT IF EXISTS "order_bracket_intent_positive_ck",
  DROP CONSTRAINT IF EXISTS "order_bracket_intent_kind_ck",
  ADD CONSTRAINT "order_bracket_intent_kind_ck" CHECK (
    ("kind" = 'bracket' AND "take_profit" > 0 AND "stop_loss" IS NOT NULL AND "stop_loss" > 0)
    OR ("kind" = 'oto' AND "take_profit" > 0 AND "stop_loss" IS NULL)
  );
