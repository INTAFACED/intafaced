-- trade.order_stop_trigger · which stop it is: a stop-limit, or a stop-market placed at its protection price (J-cex-spot-08 #3)
-- Reversal: 20261024153819_order_stop_trigger_kind.down.sql
--
-- A stop-market rests as the stop-limit it becomes (its limit is the owner's protection price from the stop), so the
-- kind is the only thing that tells the two apart on the wire. Every row before this one is a stop-limit.

ALTER TABLE "trade"."order_stop_trigger"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'stop_limit';

ALTER TABLE "trade"."order_stop_trigger"
  DROP CONSTRAINT IF EXISTS "order_stop_trigger_kind_ck",
  ADD CONSTRAINT "order_stop_trigger_kind_ck" CHECK ("kind" IN ('stop_limit', 'stop'));
