-- trade.liquidation_rungs and trade.futures_orders · liquidation by a reduce-only IOC in the book (futures ADR slice 7)
-- Reversal: 0085_futures_matched_liquidation.down.sql
--
-- docs/adr/2026-10-20-futures-matched-traders.md section 5. While matched orders are on, a liquidation rung no longer
-- closes its tranche at the mark. It is a rung of kind `matched`: it stays live (and holds the position, exactly as
-- every other live rung does) while one reduce-only IOC order works the tranche in the book, and, once every fill of
-- that order has settled, while the part the book did not take goes to ADL at the bankruptcy price. The rung posts
-- nothing itself: the order's fills post through the reduce-fill path and the ADL pairs through theirs.
--
-- `liquidation_rung_id` names the rung a liquidation order works for. It is how the fill path tells the liquidation's
-- own fill (which the live rung must not hold back) from every other fill on the position (which it holds). One
-- order per rung. The column is an identity, never an amount.
ALTER TABLE "trade"."liquidation_rungs" DROP CONSTRAINT IF EXISTS "liquidation_rungs_kind_ck";
ALTER TABLE "trade"."liquidation_rungs" ADD CONSTRAINT "liquidation_rungs_kind_ck"
  CHECK ("kind" IN ('partial', 'closing', 'matched'));

ALTER TABLE "trade"."futures_orders"
  ADD COLUMN IF NOT EXISTS "liquidation_rung_id" uuid;

-- Only a reduce-only order can be a liquidation order: it locks no margin and names the position it shrinks.
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_liquidation_reduce_ck";
ALTER TABLE "trade"."futures_orders" ADD CONSTRAINT "futures_orders_liquidation_reduce_ck"
  CHECK ("liquidation_rung_id" IS NULL OR "reduce_only");

CREATE UNIQUE INDEX IF NOT EXISTS "futures_orders_liquidation_rung_uniq"
  ON "trade"."futures_orders" ("liquidation_rung_id") WHERE "liquidation_rung_id" IS NOT NULL;

-- A liquidation order's fill intents carry its rung too. They are netted across the rung (no profit paid and no free
-- margin released before the book is done, the insurance fund drawn only for the rung's net loss past its margin), so
-- the per-row PnL identity of 0084 holds over the rung's fills and its settlement, not on each row.
ALTER TABLE "trade"."futures_order_fills"
  ADD COLUMN IF NOT EXISTS "liquidation_rung_id" uuid;

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
