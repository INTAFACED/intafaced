-- trade.orders · what the matching engine answered when an order left the book on a cancel
-- Reversal: 20261030140000_order_engine_cancel_answer.down.sql
--
-- A fill the engine matched just before a cancel is written later, by the taker's own settlement. Until it lands
-- the order's fills read short of what it bought, so the order must not be closed and its hold released.
-- engine_left_qty: the engine's own remainingQty (qty − engine_left_qty is what it matched). Null: no such answer.
-- engine_absent_at_cancel: the engine had no live order to cancel, so what it matched is unknown (it may have
-- matched in full); the fills are the only evidence, and a chase places nothing over that order's quantity.

ALTER TABLE "trade"."orders"
  ADD COLUMN IF NOT EXISTS "engine_left_qty" numeric(38, 18)
  CHECK ("engine_left_qty" IS NULL OR "engine_left_qty" >= 0);

ALTER TABLE "trade"."orders"
  ADD COLUMN IF NOT EXISTS "engine_absent_at_cancel" boolean NOT NULL DEFAULT false;
