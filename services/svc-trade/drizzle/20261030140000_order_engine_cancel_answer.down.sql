-- Reverse 20261030140000_order_engine_cancel_answer.sql
ALTER TABLE "trade"."orders" DROP COLUMN IF EXISTS "engine_absent_at_cancel";
ALTER TABLE "trade"."orders" DROP COLUMN IF EXISTS "engine_left_qty";
