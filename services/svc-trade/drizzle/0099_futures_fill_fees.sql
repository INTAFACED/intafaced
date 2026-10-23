-- trade.futures_orders and trade.futures_order_fills · a trading fee on every futures fill through the book
-- Reversal: 0099_futures_fill_fees.down.sql
--
-- docs/adr/2026-10-20-futures-matched-traders.md section 3: trading fees go to house fees through a fee recipe, never
-- into the clearing pot. An order keeps the maker and taker rates it was accepted at (the owner's published perpetual
-- schedule, TRADE_FEE_SCHEDULE, less the account's rank discount; never the listing row's maker_bps/taker_bps), so its
-- hold, and every fill it pays for, follow the terms the trader saw. An opening order's hold carries
-- the most its fills can owe at those rates, and each fill pays from it in the fill posting (futuresOrderMarginApply).
-- A reducing fill pays from the margin share it returns, in the release posting (futuresMarginRelease), so the
-- position's remaining margin is never touched by a fee. A liquidation order pays no trading fee: no liquidation fee
-- is charged unless the owner sets one (engine spec LQ-1).
--
-- An order accepted before this migration keeps rates of zero: its hold was opened without a fee, and none is taken.
-- None of these columns is spendable: the ledger postings under the fill keys are the money.
ALTER TABLE "trade"."futures_orders"
  ADD COLUMN IF NOT EXISTS "maker_fee_bps" numeric(8, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taker_fee_bps" numeric(8, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fee_charged" numeric(38, 18) NOT NULL DEFAULT 0;

ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_fee_ck";
ALTER TABLE "trade"."futures_orders" ADD CONSTRAINT "futures_orders_fee_ck" CHECK (
  "maker_fee_bps" >= 0 AND "maker_fee_bps" < 10000 AND "taker_fee_bps" >= 0 AND "taker_fee_bps" < 10000
  AND "fee_charged" >= 0
  -- A reduce-only order has no hold: its fees leave its position's pot and are counted on its fills, not here.
  AND (NOT "reduce_only" OR "fee_charged" = 0)
);

-- The fee a fill paid, the part its source could not cover (recorded, never posted), and the side it was on.
ALTER TABLE "trade"."futures_order_fills"
  ADD COLUMN IF NOT EXISTS "fee" numeric(38, 18) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fee_waived" numeric(38, 18) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "fee_role" text;

ALTER TABLE "trade"."futures_order_fills" DROP CONSTRAINT IF EXISTS "futures_order_fills_fee_ck";
ALTER TABLE "trade"."futures_order_fills" ADD CONSTRAINT "futures_order_fills_fee_ck" CHECK (
  "fee" >= 0 AND "fee_waived" >= 0
  AND ("fee_role" IS NULL OR "fee_role" IN ('maker', 'taker'))
  -- A liquidation order's fills pay no trading fee.
  AND ("liquidation_rung_id" IS NULL OR ("fee" = 0 AND "fee_waived" = 0))
);

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
    -- What leaves the position's collateral pot is the loss it pays, the share it returns and the fee taken from that
    -- share, nothing else.
    AND "pot_out" = "loss_from_margin" + "margin_release" + "fee"
    -- A fill is a profit or a loss, never both.
    AND ("profit" = 0 OR ("loss_from_margin" = 0 AND "loss_from_insurance" = 0 AND "loss_unbooked" = 0))
    -- The realised PnL is exactly what is paid or owed, booked, or (rounding only) left unbooked. A liquidation
    -- order's fills are netted across the rung (svc-trade planLiquidationFill): a fill's PnL is settled by the rung's
    -- later fills or its end-of-book settlement, so the identity holds over the rung, not over one row. The fee is
    -- not part of the realised PnL: it is reported beside it.
    AND ("liquidation_rung_id" IS NOT NULL
         OR "realized_pnl" = "profit" - "loss_from_margin" - "loss_from_insurance" - "loss_unbooked"))
);

-- A position's figures (its fees, and a closed position's summed result) are read from its applied fills on every
-- positions read; the only other index on this table covers pending rows.
CREATE INDEX IF NOT EXISTS "futures_order_fills_position_applied_idx"
  ON "trade"."futures_order_fills" ("position_id") WHERE "state" = 'applied';
