-- intafaced:destructive — reversal of 0098_futures_spread_orders.sql; drops the spread order, fill and wait tables. Refuses while any money is in flight: a spread order that may still fill or hold margin, or a fill intent still being recorded
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "trade"."futures_spread_fills" WHERE "state" = 'pending'
  ) OR EXISTS (
    SELECT 1 FROM "trade"."futures_spread_fill_waits" WHERE "settled_at" IS NULL
  ) OR EXISTS (
    SELECT 1 FROM "trade"."futures_spread_orders"
     WHERE "status" IN ('pending', 'held', 'submitting', 'open', 'submit_unknown')
        OR ("status" <> 'refused' AND COALESCE("engine_filled_qty", "qty") > "filled_qty")
  ) THEN
    RAISE EXCEPTION 'futures spread orders hold money in flight: cancel them and let every fill settle before reversing 0098';
  END IF;
END $$;
DROP TABLE IF EXISTS "trade"."futures_spread_fill_waits";
DROP TABLE IF EXISTS "trade"."futures_spread_fills";
DROP TABLE IF EXISTS "trade"."futures_spread_orders";
