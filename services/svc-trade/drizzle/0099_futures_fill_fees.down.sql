-- intafaced:destructive — reversal of 0099_futures_fill_fees.sql; drops the futures fee rates and the per-fill fee record (the fees already posted stay in the ledger; reduce fills that paid a fee must be resolved first, or the old constraint refuses them)
DROP INDEX IF EXISTS "trade"."futures_order_fills_position_applied_idx";
ALTER TABLE "trade"."futures_order_fills" DROP CONSTRAINT IF EXISTS "futures_order_fills_kind_ck";
ALTER TABLE "trade"."futures_order_fills" ADD CONSTRAINT "futures_order_fills_kind_ck" CHECK (
  ("kind" = 'open' AND "liquidation_rung_id" IS NULL AND num_nulls(
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
    -- The realised PnL is exactly what is paid or owed, booked, or (rounding only) left unbooked. A liquidation
    -- order's fills are netted across the rung (svc-trade planLiquidationFill): a fill's PnL is settled by the rung's
    -- later fills or its end-of-book settlement, so the identity holds over the rung, not over one row.
    AND ("liquidation_rung_id" IS NOT NULL
         OR "realized_pnl" = "profit" - "loss_from_margin" - "loss_from_insurance" - "loss_unbooked"))
);
ALTER TABLE "trade"."futures_order_fills" DROP CONSTRAINT IF EXISTS "futures_order_fills_fee_ck";
ALTER TABLE "trade"."futures_order_fills"
  DROP COLUMN IF EXISTS "fee_role",
  DROP COLUMN IF EXISTS "fee_waived",
  DROP COLUMN IF EXISTS "fee";

ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_fee_ck";
ALTER TABLE "trade"."futures_orders"
  DROP COLUMN IF EXISTS "fee_charged",
  DROP COLUMN IF EXISTS "taker_fee_bps",
  DROP COLUMN IF EXISTS "maker_fee_bps";
