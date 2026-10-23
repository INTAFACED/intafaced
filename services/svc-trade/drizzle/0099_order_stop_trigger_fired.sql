-- trade.order_stop_trigger · when the stop fired, and the price that reached it (J-cex-spot-06 #6)
-- Reversal: 0099_order_stop_trigger_fired.down.sql
--
-- Written once from matching.order.triggered: the first delivery wins, a redelivery changes nothing. NULL means the
-- stop has not fired (or fired before this record existed): the order page says "not recorded", never a guess.

ALTER TABLE "trade"."order_stop_trigger"
  ADD COLUMN IF NOT EXISTS "triggered_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "trigger_reference" numeric(38, 18),
  ADD COLUMN IF NOT EXISTS "trigger_by" text,
  ADD COLUMN IF NOT EXISTS "trigger_sequence" bigint;

ALTER TABLE "trade"."order_stop_trigger"
  DROP CONSTRAINT IF EXISTS "order_stop_trigger_fired_ck",
  ADD CONSTRAINT "order_stop_trigger_fired_ck" CHECK (
    ("triggered_at" IS NULL AND "trigger_reference" IS NULL AND "trigger_by" IS NULL AND "trigger_sequence" IS NULL)
    OR ("triggered_at" IS NOT NULL AND "trigger_reference" > 0 AND "trigger_by" IN ('last', 'mark', 'index')
        AND "trigger_sequence" IS NOT NULL)
  );
