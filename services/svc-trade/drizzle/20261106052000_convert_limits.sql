-- trade.convert_limits · a limit convert: convert at a target rate or better (J-cex-spot-11 #8, SP-convert-buy-01)
-- Reversal: 20261106052000_convert_limits.down.sql
--
-- One row per limit convert. Placing it holds the whole source amount on the ledger (`order.hold:<id>`), so the
-- customer cannot spend it twice while it waits. The sweep prices a firm convert quote for the amount each tick; once
-- the quote's own rate (spread included) reaches the target it claims the row (waiting -> triggered, one worker wins),
-- gives the hold back (`order.release:<id>:0`) and settles that one quote through the ordinary convert path, whose
-- ledger keys are the quote's: the limit fills once, and what the fill did not use is free again. A crash after the
-- claim replays the same release and the same quote. A cancel claims the row the same way (waiting -> cancelling) and
-- releases the hold once. `client_limit_id` is the caller's request id: the same one again answers the same row.

CREATE TABLE IF NOT EXISTS "trade"."convert_limits" (
  "id" uuid PRIMARY KEY,
  "user_id" text NOT NULL,
  "client_limit_id" text NOT NULL,
  "symbol" text NOT NULL,
  "market_id" text NOT NULL,
  "side" text NOT NULL,
  "from_asset" text NOT NULL,
  "to_asset" text NOT NULL,
  "amount" numeric(38, 18) NOT NULL,
  "target_rate" numeric(38, 18) NOT NULL,
  "status" text NOT NULL,
  "quote_id" text,
  "fill_id" text,
  "paid" numeric(38, 18),
  "received" numeric(38, 18),
  "end_code" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "convert_limits_client_uq" UNIQUE ("user_id", "client_limit_id"),
  CONSTRAINT "convert_limits_side_ck" CHECK ("side" IN ('buy', 'sell')),
  CONSTRAINT "convert_limits_status_ck" CHECK (
    "status" IN ('placing', 'waiting', 'triggered', 'filled', 'cancelling', 'cancelled', 'ended')
  ),
  CONSTRAINT "convert_limits_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "convert_limits_target_ck" CHECK ("target_rate" > 0),
  CONSTRAINT "convert_limits_triggered_quote_ck" CHECK ("status" NOT IN ('triggered', 'filled') OR "quote_id" IS NOT NULL),
  CONSTRAINT "convert_limits_filled_ck" CHECK (
    "status" <> 'filled' OR ("fill_id" IS NOT NULL AND "paid" IS NOT NULL AND "received" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "convert_limits_live_idx"
  ON "trade"."convert_limits" ("status")
  WHERE "status" IN ('placing', 'waiting', 'triggered', 'cancelling');

CREATE INDEX IF NOT EXISTS "convert_limits_user_idx" ON "trade"."convert_limits" ("user_id", "created_at" DESC);
