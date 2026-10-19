-- trade.order_bracket_intent · the exit prices of a bracket, written before its entry is placed
-- Reversal: 0070_order_bracket_intent.down.sql
--
-- A bracket is an entry plus one sell OCO placed for the base actually received. The exit prices are
-- stored under the entry's deterministic order id BEFORE the entry hold, so a crash after the entry fills
-- never loses what the exit should have been. `exit_order_id` is set once the exit OCO exists; a retry of
-- the same client order id finds the intent, sees the exit missing, and places it with the same key.

CREATE TABLE IF NOT EXISTS "trade"."order_bracket_intent" (
  "order_id"      uuid PRIMARY KEY,
  "user_id"       uuid NOT NULL,
  "take_profit"   numeric(38, 18) NOT NULL,
  "stop_loss"     numeric(38, 18) NOT NULL,
  "exit_order_id" uuid,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_bracket_intent_positive_ck" CHECK ("take_profit" > 0 AND "stop_loss" > 0)
);
