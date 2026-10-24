-- intafaced:destructive — reversal of 20261024062001_futures_order_origin_label.sql drops where each futures order came
-- from and the trader's labels on them. No money is in either column: holds, fills and releases are untouched, and an
-- order's origin can still be read off its client id (`cond:`, `rv:`) or its liquidation rung.
DROP INDEX IF EXISTS "trade"."futures_orders_user_label_idx";
DROP INDEX IF EXISTS "trade"."futures_orders_user_created_idx";
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_label_ck";
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_origin_ck";
ALTER TABLE "trade"."futures_orders"
  DROP COLUMN IF EXISTS "order_label",
  DROP COLUMN IF EXISTS "origin_ref",
  DROP COLUMN IF EXISTS "origin";
