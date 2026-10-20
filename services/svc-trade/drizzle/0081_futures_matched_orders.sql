-- trade.futures_orders and trade.futures_order_fills · futures orders placed through svc-matching (futures ADR slice 6)
-- Reversal: 0081_futures_matched_orders.down.sql
--
-- docs/adr/2026-10-20-futures-matched-traders.md sections 1, 2 and 8. A row in trade.futures_orders is the
-- ORDER's margin book: the order's terms (the hold it locked is computed from them, never stored as a figure of
-- its own), the cumulative quantity and adverse distance the next fill's margin is computed from, and what fills
-- and releases have already moved out of the hold.
-- A row in trade.futures_order_fills is an intent to post one futures.fill: it is written before the ledger
-- call, under the key `<marketId>:<sequence>:<positionId>`, and it turns `applied` once the position row has
-- caught up with the post. Neither table is spendable. The ledger hold `futures-order:<id>` and the position
-- collateral pots are the money.
CREATE TABLE IF NOT EXISTS "trade"."futures_orders" (
  "id"               uuid            PRIMARY KEY,
  "user_id"          text            NOT NULL,
  "market_id"        uuid            NOT NULL REFERENCES "trade"."markets" ("id"),
  "client_order_id"  text            NOT NULL,
  "side"             text            NOT NULL,
  "order_type"       text            NOT NULL,
  "qty"              numeric(38, 18) NOT NULL,
  "limit_price"      numeric(38, 18) NOT NULL,
  "mark_price"       numeric(38, 18) NOT NULL,
  "band_low"         numeric(38, 18) NOT NULL,
  "band_high"        numeric(38, 18) NOT NULL,
  "leverage"         numeric(8, 2)   NOT NULL,
  "hold_asset"       text            NOT NULL,
  "filled_qty"       numeric(38, 18) NOT NULL DEFAULT 0,
  "adverse_num"      numeric(78, 0)  NOT NULL DEFAULT 0,
  "applied_amount"   numeric(38, 18) NOT NULL DEFAULT 0,
  "released_amount"  numeric(38, 18) NOT NULL DEFAULT 0,
  -- What the engine says it filled in all once the order left the book (qty less the cancellation's
  -- remainingQty; 0 on a rejection). NULL while the order may still fill. The unused hold is released only
  -- when filled_qty has caught up with it, so a fill the engine printed before a cancel still settles.
  "engine_filled_qty" numeric(38, 18),
  "status"           text            NOT NULL DEFAULT 'pending',
  "refusal_code"     text,
  "created_at"       timestamptz     NOT NULL DEFAULT now(),
  "updated_at"       timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT "futures_orders_client_uniq" UNIQUE ("user_id", "market_id", "client_order_id"),
  CONSTRAINT "futures_orders_side_ck" CHECK ("side" IN ('buy', 'sell')),
  CONSTRAINT "futures_orders_type_ck" CHECK ("order_type" IN ('limit', 'market')),
  CONSTRAINT "futures_orders_qty_ck" CHECK ("qty" > 0),
  CONSTRAINT "futures_orders_price_ck" CHECK ("limit_price" > 0 AND "mark_price" > 0 AND "band_low" > 0),
  CONSTRAINT "futures_orders_band_ck" CHECK ("band_low" <= "mark_price" AND "mark_price" <= "band_high"),
  CONSTRAINT "futures_orders_leverage_ck" CHECK ("leverage" > 0),
  CONSTRAINT "futures_orders_filled_ck" CHECK ("filled_qty" >= 0 AND "filled_qty" <= "qty" AND "adverse_num" >= 0),
  CONSTRAINT "futures_orders_engine_filled_ck" CHECK (
    "engine_filled_qty" IS NULL OR ("engine_filled_qty" >= 0 AND "engine_filled_qty" <= "qty")
  ),
  CONSTRAINT "futures_orders_applied_ck" CHECK ("applied_amount" >= 0 AND "released_amount" >= 0),
  CONSTRAINT "futures_orders_status_ck" CHECK (
    "status" IN ('pending', 'held', 'submitting', 'open', 'filled', 'cancelled', 'rejected', 'refused', 'submit_unknown')
  )
);

CREATE INDEX IF NOT EXISTS "futures_orders_market_status_idx"
  ON "trade"."futures_orders" ("market_id", "status");

CREATE TABLE IF NOT EXISTS "trade"."futures_order_fills" (
  "fill_key"        text            PRIMARY KEY,
  "order_id"        uuid            NOT NULL REFERENCES "trade"."futures_orders" ("id"),
  "market_id"       uuid            NOT NULL REFERENCES "trade"."markets" ("id"),
  "engine_sequence" bigint          NOT NULL,
  "position_id"     uuid            NOT NULL,
  "qty"             numeric(38, 18) NOT NULL,
  "price"           numeric(38, 18) NOT NULL,
  "amount"          numeric(38, 18) NOT NULL,
  "new_filled"      numeric(38, 18) NOT NULL,
  "new_adverse"     numeric(78, 0)  NOT NULL,
  "new_applied"     numeric(38, 18) NOT NULL,
  "state"           text            NOT NULL DEFAULT 'pending',
  "created_at"      timestamptz     NOT NULL DEFAULT now(),
  "applied_at"      timestamptz,
  CONSTRAINT "futures_order_fills_order_seq_uniq" UNIQUE ("order_id", "engine_sequence"),
  CONSTRAINT "futures_order_fills_qty_ck" CHECK ("qty" > 0),
  CONSTRAINT "futures_order_fills_price_ck" CHECK ("price" > 0),
  CONSTRAINT "futures_order_fills_amount_ck" CHECK ("amount" >= 0 AND "new_applied" >= "amount"),
  CONSTRAINT "futures_order_fills_state_ck" CHECK ("state" IN ('pending', 'applied')),
  CONSTRAINT "futures_order_fills_applied_at_ck" CHECK (("state" = 'applied') = ("applied_at" IS NOT NULL))
);

-- A fill that is still being recorded holds its position: close, liquidation and margin changes refuse it.
CREATE INDEX IF NOT EXISTS "futures_order_fills_position_pending_idx"
  ON "trade"."futures_order_fills" ("position_id") WHERE "state" = 'pending';
CREATE INDEX IF NOT EXISTS "futures_order_fills_order_pending_idx"
  ON "trade"."futures_order_fills" ("order_id") WHERE "state" = 'pending';
