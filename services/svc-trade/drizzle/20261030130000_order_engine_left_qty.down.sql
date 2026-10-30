-- Reverse 20261030130000_order_engine_left_qty.sql
ALTER TABLE "trade"."orders" DROP COLUMN IF EXISTS "engine_left_qty";
