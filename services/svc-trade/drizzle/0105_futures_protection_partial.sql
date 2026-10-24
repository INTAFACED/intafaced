-- A position's take profit or stop loss may cover a part of the position (J-derivatives-03 step 3, D-orders-05).
-- `part_leg` is true on a take-profit or stop-loss leg with its own fixed quantity. False, the default, is a leg that
-- closes the position as it is when it fires (every leg armed before this, and any a not-yet-updated writer arms), and
-- every free-standing stop.
ALTER TABLE trade.futures_conditional_orders ADD COLUMN IF NOT EXISTS "part_leg" boolean NOT NULL DEFAULT false;
ALTER TABLE trade.futures_conditional_orders
  ADD CONSTRAINT "futures_conditional_orders_part_leg_ck" CHECK (NOT "part_leg" OR "attachment" IS NOT NULL);
