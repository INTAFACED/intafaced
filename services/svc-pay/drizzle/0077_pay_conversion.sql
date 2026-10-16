-- W6 USD → USDT conversion, sandbox only.
-- Reversal: 0077_pay_conversion.down.sql
--
-- A quote is the bid, minus the configured slippage, plus the fee and spread a
-- pricing rule locked. An order row is committed BEFORE the venue is called,
-- then compare-and-set to `placing` so only one caller places. `client_order_id`
-- is the settlement uuid without dashes plus the attempt in base 36, at most
-- 36 characters. One settlement has at most one live order.
--
-- No rate, fee, spread, minimum or TTL is stored as a default. A missing input
-- is a missing row, and the service refuses.

CREATE TABLE IF NOT EXISTS "pay"."conversion_quotes" (
  "id"               uuid PRIMARY KEY,
  "merchant_id"      uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "settlement_id"    uuid NOT NULL REFERENCES "pay"."settlements"("id"),
  "from_asset"       text NOT NULL,
  "to_asset"         text NOT NULL,
  "from_amount"      numeric(60, 18) NOT NULL,
  "rate"             numeric(60, 18) NOT NULL,
  "fee_amount"       numeric(60, 18) NOT NULL,
  "spread_amount"    numeric(60, 18) NOT NULL,
  "minimum_output"   numeric(60, 18) NOT NULL,
  "expected_output"  numeric(60, 18) NOT NULL,
  "gross_output"     numeric(60, 18) NOT NULL,
  "venue_id"         text NOT NULL,
  "symbol"           text NOT NULL,
  "expires_at"       timestamptz NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversion_quotes_pair" CHECK ("from_asset" = 'USD' AND "to_asset" = 'USDT'),
  CONSTRAINT "conversion_quotes_amounts" CHECK (
    "from_amount" > 0 AND "rate" > 0 AND "fee_amount" >= 0 AND "spread_amount" >= 0
    AND "minimum_output" > 0 AND "expected_output" > 0 AND "gross_output" > 0
  )
);

CREATE INDEX IF NOT EXISTS "conversion_quotes_merchant_idx"
  ON "pay"."conversion_quotes" ("merchant_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "pay"."conversion_orders" (
  "id"                  uuid PRIMARY KEY,
  "request_id"          uuid NOT NULL,
  "quote_id"            uuid NOT NULL REFERENCES "pay"."conversion_quotes"("id"),
  "merchant_id"         uuid NOT NULL REFERENCES "pay"."merchants"("id"),
  "settlement_id"       uuid NOT NULL REFERENCES "pay"."settlements"("id"),
  "attempt"             integer NOT NULL,
  "client_order_id"     text NOT NULL,
  "venue_id"            text NOT NULL,
  "symbol"              text NOT NULL,
  "status"              text NOT NULL,
  "from_asset"          text NOT NULL,
  "to_asset"            text NOT NULL,
  "from_amount"         numeric(60, 18) NOT NULL,
  "filled_from_amount"  numeric(60, 18) NOT NULL DEFAULT 0,
  "filled_to_amount"    numeric(60, 18) NOT NULL DEFAULT 0,
  "fee_amount"          numeric(60, 18) NOT NULL,
  "spread_amount"       numeric(60, 18) NOT NULL,
  "minimum_output"      numeric(60, 18) NOT NULL,
  "failure_code"        text,
  "venue_order_id"      text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "conversion_orders_pair" CHECK ("from_asset" = 'USD' AND "to_asset" = 'USDT'),
  CONSTRAINT "conversion_orders_attempt" CHECK ("attempt" >= 1),
  CONSTRAINT "conversion_orders_client_id" CHECK (
    length(btrim("client_order_id")) > 0 AND length("client_order_id") <= 36
  ),
  CONSTRAINT "conversion_orders_status" CHECK ("status" IN (
    'intent_committed', 'placing', 'placed', 'partially_filled', 'filled', 'failed', 'reversed', 'expired'
  )),
  CONSTRAINT "conversion_orders_amounts" CHECK (
    "from_amount" > 0 AND "filled_from_amount" >= 0 AND "filled_to_amount" >= 0
    AND "fee_amount" >= 0 AND "spread_amount" >= 0 AND "minimum_output" > 0
    AND "filled_from_amount" <= "from_amount"
  )
);

-- One venue order per quote, including a failed or expired one. A second
-- request id for that quote is refused; the same request id resumes.
CREATE UNIQUE INDEX IF NOT EXISTS "conversion_orders_request_idx"
  ON "pay"."conversion_orders" ("request_id");
CREATE UNIQUE INDEX IF NOT EXISTS "conversion_orders_quote_idx"
  ON "pay"."conversion_orders" ("quote_id");
CREATE UNIQUE INDEX IF NOT EXISTS "conversion_orders_client_idx"
  ON "pay"."conversion_orders" ("client_order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "conversion_orders_attempt_idx"
  ON "pay"."conversion_orders" ("settlement_id", "attempt");
-- One live attempt per settlement. A filled, failed, reversed or expired row
-- does not hold the slot. `placing` is live: a miss must not start another.
CREATE UNIQUE INDEX IF NOT EXISTS "conversion_orders_one_live_idx"
  ON "pay"."conversion_orders" ("settlement_id")
  WHERE "status" IN ('intent_committed', 'placing', 'placed');
CREATE INDEX IF NOT EXISTS "conversion_orders_open_idx"
  ON "pay"."conversion_orders" ("from_asset", "status");
CREATE INDEX IF NOT EXISTS "conversion_orders_merchant_idx"
  ON "pay"."conversion_orders" ("merchant_id", "created_at" DESC, "id" DESC);
