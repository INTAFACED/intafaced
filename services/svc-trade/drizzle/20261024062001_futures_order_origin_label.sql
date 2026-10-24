-- Where a futures order came from, and the trader's own label on it (J-derivatives-04 steps 1 and 2, D-orders-03).
-- Reversal: 20261024062001_futures_order_origin_label.down.sql
--
-- origin says who placed the order: the trader (`user`), a fired conditional order of theirs (`stop`, `take_profit`,
-- `stop_loss`, `trailing_stop`; origin_ref is that conditional order's id), a liquidation (`liquidation`; origin_ref is
-- the rung) or a one-tap reverse (`reverse`; origin_ref is the request id). It is written by the service that places
-- the order, never read from the request body, so a trader cannot name their own order a stop or a liquidation.
-- order_label is the trader's free tag (1-36 of A-Z a-z 0-9 . _ : -), per user, never an owner or a key.
-- Neither column is money: the hold, the fills and the release are unchanged.
ALTER TABLE "trade"."futures_orders"
  ADD COLUMN IF NOT EXISTS "origin" text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS "origin_ref" text,
  ADD COLUMN IF NOT EXISTS "order_label" text;

ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_origin_ck";
ALTER TABLE "trade"."futures_orders" ADD CONSTRAINT "futures_orders_origin_ck" CHECK (
  "origin" IN ('user', 'stop', 'take_profit', 'stop_loss', 'trailing_stop', 'liquidation', 'reverse')
);
ALTER TABLE "trade"."futures_orders" DROP CONSTRAINT IF EXISTS "futures_orders_label_ck";
ALTER TABLE "trade"."futures_orders" ADD CONSTRAINT "futures_orders_label_ck" CHECK (
  "order_label" IS NULL OR "order_label" ~ '^[A-Za-z0-9._:-]{1,36}$'
);

-- Orders placed before this migration: the same rules the services now write by, read off what they stored.
UPDATE "trade"."futures_orders"
   SET "origin" = 'liquidation', "origin_ref" = "liquidation_rung_id"::text
 WHERE "liquidation_rung_id" IS NOT NULL AND "origin" = 'user';

UPDATE "trade"."futures_orders" o
   SET "origin" = CASE
         WHEN c."attachment" IS NOT NULL THEN c."attachment"
         WHEN c."kind" = 'take_profit' THEN 'take_profit'
         WHEN c."kind" = 'trailing_stop' THEN 'trailing_stop'
         ELSE 'stop'
       END,
       "origin_ref" = c."id"::text
  FROM "trade"."futures_conditional_orders" c
 WHERE o."origin" = 'user'
   AND o."client_order_id" ~ '^cond:[0-9a-f-]{36}(:[0-9]+)?$'
   AND c."id"::text = substring(o."client_order_id" FROM 6 FOR 36)
   AND c."user_id" = o."user_id";

UPDATE "trade"."futures_orders" o
   SET "origin" = 'reverse', "origin_ref" = r."client_request_id"
  FROM "trade"."futures_reverse_requests" r
 WHERE o."origin" = 'user'
   AND o."client_order_id" IN ('rv:c:' || r."client_request_id", 'rv:o:' || r."client_request_id")
   AND r."user_id" = o."user_id";

-- The orders room reads a user's orders newest first, by label and by origin.
CREATE INDEX IF NOT EXISTS "futures_orders_user_created_idx"
  ON "trade"."futures_orders" ("user_id", "created_at" DESC, "id");
CREATE INDEX IF NOT EXISTS "futures_orders_user_label_idx"
  ON "trade"."futures_orders" ("user_id", "order_label") WHERE "order_label" IS NOT NULL;
