-- trade.futures_orders and trade.futures_order_fills · reduce-only futures orders through svc-matching (futures ADR slice 6b)
-- Reversal: 0096_futures_reduce_only_orders.down.sql
--
-- docs/adr/2026-10-20-futures-matched-traders.md sections 1, 3 and 4. A reduce-only order names the open isolated
-- position it shrinks and locks no margin: what it can lose is bounded by that position's bankruptcy price, which
-- is stored with the order so the bound it was placed under can be checked again later.
--
-- A reduce fill is still one intent row in trade.futures_order_fills, written before the first ledger call. It
-- carries the amounts the fill posts (the margin share it returns, the loss it books into the clearing pot, the
-- profit the clearing pot pays or owes) and what it takes off the position row. None of these columns is
-- spendable: the ledger postings under the fill's keys are the money, and the position collateral pot is checked
-- against the row.
ALTER TABLE "trade"."futures_orders"
  ADD COLUMN IF NOT EXISTS "reduce_only" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "position_id" uuid,
  ADD COLUMN IF NOT EXISTS "bankruptcy_price" numeric(38, 18);

ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_reduce_target_ck";
ALTER TABLE "trade"."futures_orders" ADD CONSTRAINT "futures_orders_reduce_target_ck" CHECK (
  ("reduce_only" AND "position_id" IS NOT NULL AND "bankruptcy_price" IS NOT NULL AND "bankruptcy_price" >= 0)
  OR (NOT "reduce_only" AND "position_id" IS NULL AND "bankruptcy_price" IS NULL)
);
-- A reduce-only order moves no margin into a position, so nothing is ever applied out of a hold it does not have.
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_reduce_no_hold_ck";
ALTER TABLE "trade"."futures_orders" ADD CONSTRAINT "futures_orders_reduce_no_hold_ck" CHECK (
  NOT "reduce_only" OR ("applied_amount" = 0 AND "released_amount" = 0 AND "adverse_num" = 0)
);

CREATE INDEX IF NOT EXISTS "futures_orders_position_idx"
  ON "trade"."futures_orders" ("position_id") WHERE "reduce_only";

ALTER TABLE "trade"."futures_order_fills"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS "realized_pnl" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "loss_from_margin" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "loss_from_insurance" numeric(38, 18),
  -- Charge-up rounding past the whole margin, inside the bankruptcy bound: at most one unit per earlier reduce fill
  -- on the position. Recorded, never posted: the bound promises a reduce inside it never loses more than the margin.
  ADD COLUMN IF NOT EXISTS "loss_unbooked" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "profit" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "margin_release" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "pot_out" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "initial_out" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "closes_position" boolean;

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
