-- Reverse 20261031050000_order_engine_absent_since.sql
ALTER TABLE "trade"."orders" DROP COLUMN IF EXISTS "engine_absent_since";
