-- intafaced:destructive — reversal of 0085_futures_matched_liquidation.sql; drops the liquidation order and fill links and the matched rung kind (rows of that kind must be resolved first)
ALTER TABLE "trade"."futures_order_fills" DROP CONSTRAINT IF EXISTS "futures_order_fills_kind_ck";
ALTER TABLE "trade"."futures_order_fills" ADD CONSTRAINT "futures_order_fills_kind_ck" CHECK (
  ("kind" = 'open' AND num_nulls(
    "realized_pnl", "loss_from_margin", "loss_from_insurance", "loss_unbooked", "profit", "margin_release",
    "pot_out", "initial_out", "closes_position") = 9)
  OR ("kind" = 'reduce' AND "amount" = 0 AND num_nonnulls(
    "realized_pnl", "loss_from_margin", "loss_from_insurance", "loss_unbooked", "profit", "margin_release",
    "pot_out", "initial_out", "closes_position") = 9
    AND "loss_from_margin" >= 0 AND "loss_from_insurance" >= 0 AND "loss_unbooked" >= 0
    AND "profit" >= 0 AND "margin_release" >= 0 AND "initial_out" >= 0
    -- What leaves the position's collateral pot is the loss it pays and the share it returns, nothing else.
    AND "pot_out" = "loss_from_margin" + "margin_release"
    -- A fill is a profit or a loss, never both.
    AND ("profit" = 0 OR ("loss_from_margin" = 0 AND "loss_from_insurance" = 0 AND "loss_unbooked" = 0))
    -- The realised PnL is exactly what is paid or owed, booked, or (rounding only) left unbooked.
    AND "realized_pnl" = "profit" - "loss_from_margin" - "loss_from_insurance" - "loss_unbooked")
);
ALTER TABLE "trade"."futures_order_fills" DROP COLUMN IF EXISTS "liquidation_rung_id";

DROP INDEX IF EXISTS "trade"."futures_orders_liquidation_rung_uniq";
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_liquidation_reduce_ck";
ALTER TABLE "trade"."futures_orders" DROP COLUMN IF EXISTS "liquidation_rung_id";

ALTER TABLE "trade"."liquidation_rungs" DROP CONSTRAINT IF EXISTS "liquidation_rungs_kind_ck";
ALTER TABLE "trade"."liquidation_rungs" ADD CONSTRAINT "liquidation_rungs_kind_ck"
  CHECK ("kind" IN ('partial', 'closing'));
