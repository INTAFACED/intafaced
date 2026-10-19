-- trade.order_oco_intent · the legs of an OCO parent, written before its hold is placed
-- Reversal: 0073_order_oco_intent.down.sql
--
-- An OCO parent rests as two legs in the engine, but its own row is an ordinary limit order. If the hold
-- outcome is unknown and the order is resubmitted from that row, the resubmit must send the same legs, not a
-- plain limit (a buy OCO would otherwise become an immediate buy at its worst price). The legs are stored under
-- the parent's deterministic order id before the hold; a retry with different legs is refused.

CREATE TABLE IF NOT EXISTS "trade"."order_oco_intent" (
  "order_id"        uuid PRIMARY KEY,
  "user_id"         uuid NOT NULL,
  "take_profit"     numeric(38, 18) NOT NULL,
  "stop_loss"       numeric(38, 18) NOT NULL,
  "stop_loss_limit" numeric(38, 18),
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_oco_intent_positive_ck" CHECK ("take_profit" > 0 AND "stop_loss" > 0 AND ("stop_loss_limit" IS NULL OR "stop_loss_limit" > 0))
);
