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
