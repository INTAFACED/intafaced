-- The price a futures conditional order is judged on (J-derivatives-03 step 5, D-orders-04).
-- Reversal: 20261024051744_futures_conditional_trigger_source.down.sql
--
-- mark (the published mark, as every order before this was) or last (the futures book's newest trade on the market).
-- The index is not a stored source: it is not published on this deployment, and an order asking for it is refused by
-- name. The default keeps every existing row, and any row a not-yet-updated instance writes during a rolling deploy,
-- on the mark. The index serves the last-trade read: the newest fill of a market.
ALTER TABLE "trade"."futures_conditional_orders"
  ADD COLUMN IF NOT EXISTS "trigger_source" text NOT NULL DEFAULT 'mark';

ALTER TABLE "trade"."futures_conditional_orders"
  DROP CONSTRAINT IF EXISTS "futures_conditional_orders_trigger_source_ck";
ALTER TABLE "trade"."futures_conditional_orders"
  ADD CONSTRAINT "futures_conditional_orders_trigger_source_ck" CHECK ("trigger_source" IN ('mark', 'last'));

CREATE INDEX IF NOT EXISTS "futures_order_fills_market_sequence_idx"
  ON "trade"."futures_order_fills" ("market_id", "engine_sequence" DESC);
