-- intafaced:destructive — reversal of 20261024153819_order_stop_trigger_kind.sql
ALTER TABLE "trade"."order_stop_trigger" DROP CONSTRAINT IF EXISTS "order_stop_trigger_kind_ck";
ALTER TABLE "trade"."order_stop_trigger" DROP COLUMN IF EXISTS "kind";
