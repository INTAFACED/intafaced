-- intafaced:destructive — reversal of 0100_order_stop_trigger_fired.sql
-- Drops when each stop fired and the price that reached it. The stop prices themselves stay.
ALTER TABLE "trade"."order_stop_trigger" DROP CONSTRAINT IF EXISTS "order_stop_trigger_fired_ck";
ALTER TABLE "trade"."order_stop_trigger"
  DROP COLUMN IF EXISTS "triggered_at",
  DROP COLUMN IF EXISTS "trigger_reference",
  DROP COLUMN IF EXISTS "trigger_by",
  DROP COLUMN IF EXISTS "trigger_sequence";
