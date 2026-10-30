-- trade.orders · engine_left_qty: what the matching engine still held of an order when it took it off the book
-- Reversal: 20261030130000_order_engine_left_qty.down.sql
--
-- A fill the engine matched just before a cancel is written later, by the taker's own settlement, so for a moment
-- the order's fills read short of what it bought. qty − engine_left_qty is what the engine matched; a chase re-price
-- places nothing new until the fills reach it. Null: the engine has not said (not cancelled through it, or unknown).

ALTER TABLE "trade"."orders"
  ADD COLUMN IF NOT EXISTS "engine_left_qty" numeric(38, 18)
  CHECK ("engine_left_qty" IS NULL OR "engine_left_qty" >= 0);
