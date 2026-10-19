-- trade.orders · stop trigger echoed on a stop-limit order
-- Reversal: 0069_order_stop_trigger.down.sql
--
-- The trigger price is the caller's stopPrice. It is written before the hold, keyed by the
-- deterministic order id, so a crash after the hold never leaves a live stop with no record.
-- A replay of the same client order id reads this row and returns the first trigger.

CREATE TABLE IF NOT EXISTS "trade"."order_stop_trigger" (
  "order_id"    uuid PRIMARY KEY,
  "user_id"     uuid NOT NULL,
  "stop_price"  numeric(38, 18) NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "order_stop_trigger_positive_ck" CHECK ("stop_price" > 0)
);
