-- intafaced:destructive — reversal of 0096_futures_reduce_only_orders.sql; drops the reduce-only order columns and the reduce fill intents' amounts
ALTER TABLE "trade"."futures_order_fills" DROP CONSTRAINT IF EXISTS "futures_order_fills_kind_ck";
ALTER TABLE "trade"."futures_order_fills"
  DROP COLUMN IF EXISTS "closes_position",
  DROP COLUMN IF EXISTS "initial_out",
  DROP COLUMN IF EXISTS "pot_out",
  DROP COLUMN IF EXISTS "margin_release",
  DROP COLUMN IF EXISTS "profit",
  DROP COLUMN IF EXISTS "loss_unbooked",
  DROP COLUMN IF EXISTS "loss_from_insurance",
  DROP COLUMN IF EXISTS "loss_from_margin",
  DROP COLUMN IF EXISTS "realized_pnl",
  DROP COLUMN IF EXISTS "kind";

DROP INDEX IF EXISTS "trade"."futures_orders_position_idx";
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_reduce_no_hold_ck";
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_reduce_target_ck";
ALTER TABLE "trade"."futures_orders"
  DROP COLUMN IF EXISTS "bankruptcy_price",
  DROP COLUMN IF EXISTS "position_id",
  DROP COLUMN IF EXISTS "reduce_only";
