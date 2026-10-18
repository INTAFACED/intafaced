-- intafaced:destructive — reversal of 0062_order_events.sql
DROP TRIGGER IF EXISTS "order_events_no_truncate" ON "trade"."order_events";
DROP TRIGGER IF EXISTS "order_events_immutable" ON "trade"."order_events";
DROP FUNCTION IF EXISTS "trade"."order_events_no_truncate"();
DROP FUNCTION IF EXISTS "trade"."order_events_immutable"();
DROP TABLE IF EXISTS "trade"."order_events";
