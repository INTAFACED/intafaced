-- intafaced:destructive — reversal of 0085_futures_matched_liquidation.sql; drops the liquidation order link and the matched rung kind (rows of that kind must be resolved first)
DROP INDEX IF EXISTS "trade"."futures_orders_liquidation_rung_uniq";
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_liquidation_reduce_ck";
ALTER TABLE "trade"."futures_orders" DROP COLUMN IF EXISTS "liquidation_rung_id";

ALTER TABLE "trade"."liquidation_rungs" DROP CONSTRAINT IF EXISTS "liquidation_rungs_kind_ck";
ALTER TABLE "trade"."liquidation_rungs" ADD CONSTRAINT "liquidation_rungs_kind_ck"
  CHECK ("kind" IN ('partial', 'closing'));
