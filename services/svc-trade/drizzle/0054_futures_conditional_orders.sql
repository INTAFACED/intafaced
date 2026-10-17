-- Futures conditional orders: stop, stop-limit, take-profit, trailing, and attached protection.
-- Reversal: 0054_futures_conditional_orders.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by FUTCONDBE before this file was written.
--
-- Amounts are numeric. The service writes decimal strings; it does not invent a price.
-- trigger_key is null until a worker claims the row. The unique key is what makes
-- a second worker's claim update zero rows. Attached exits (attachment set) are
-- cancelled by the close trigger; a claimed row is already off 'armed', so the
-- exit that fired is not cancelled by its own close.

CREATE TABLE IF NOT EXISTS "trade"."futures_conditional_orders" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "market_id" uuid NOT NULL REFERENCES "trade"."markets" ("id"),
  "position_id" uuid REFERENCES "trade"."positions" ("id"),
  "client_order_id" text NOT NULL,
  "kind" text NOT NULL,
  "side" text NOT NULL,
  "quantity" numeric(38, 18) NOT NULL,
  "trigger_price" numeric(38, 18),
  "limit_price" numeric(38, 18),
  "trailing_distance" numeric(38, 18),
  "trail_extreme" numeric(38, 18),
  "reduce_only" boolean NOT NULL,
  "attachment" text,
  "status" text NOT NULL,
  "cancel_reason" text,
  "failure_reason" text,
  "trigger_key" text,
  "request_hash" text NOT NULL,
  "result" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "futures_conditional_orders_kind_ck" CHECK (
    "kind" IN ('stop_market', 'stop_limit', 'take_profit', 'trailing_stop')
  ),
  CONSTRAINT "futures_conditional_orders_side_ck" CHECK ("side" IN ('buy', 'sell')),
  CONSTRAINT "futures_conditional_orders_status_ck" CHECK (
    "status" IN ('armed', 'triggered', 'filled', 'cancelled', 'failed')
  ),
  CONSTRAINT "futures_conditional_orders_attachment_ck" CHECK (
    "attachment" IS NULL OR "attachment" IN ('take_profit', 'stop_loss')
  ),
  CONSTRAINT "futures_conditional_orders_qty_ck" CHECK ("quantity" > 0),
  CONSTRAINT "futures_conditional_orders_reduce_only_ck" CHECK ("reduce_only" = true),
  CONSTRAINT "futures_conditional_orders_user_client_uq" UNIQUE ("user_id", "client_order_id"),
  CONSTRAINT "futures_conditional_orders_trigger_key_uq" UNIQUE ("trigger_key")
);

CREATE INDEX IF NOT EXISTS "futures_conditional_orders_armed_idx"
  ON "trade"."futures_conditional_orders" ("status", "market_id")
  WHERE "status" = 'armed';

CREATE INDEX IF NOT EXISTS "futures_conditional_orders_position_idx"
  ON "trade"."futures_conditional_orders" ("position_id")
  WHERE "attachment" IS NOT NULL;

CREATE TABLE IF NOT EXISTS "trade"."futures_protection_requests" (
  "user_id" text NOT NULL,
  "client_request_id" text NOT NULL,
  "position_id" uuid NOT NULL,
  "request_hash" text NOT NULL,
  "result" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "client_request_id")
);

CREATE OR REPLACE FUNCTION "trade"."futures_cancel_protection_on_close"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE "trade"."futures_conditional_orders"
  SET "status" = 'cancelled',
      "cancel_reason" = 'position_closed',
      "updated_at" = now()
  WHERE "position_id" = NEW."id"
    AND "user_id" = NEW."user_id"
    AND "attachment" IS NOT NULL
    AND "status" = 'armed';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "futures_protection_on_close" ON "trade"."positions";
CREATE TRIGGER "futures_protection_on_close"
  AFTER UPDATE OF "status" ON "trade"."positions"
  FOR EACH ROW
  WHEN (NEW."status" = 'closed' AND OLD."status" IS DISTINCT FROM 'closed')
  EXECUTE FUNCTION "trade"."futures_cancel_protection_on_close"();
