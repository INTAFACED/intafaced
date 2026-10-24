-- A take profit and a stop loss attached to an opening futures order (J-derivatives-03 step 4, D-orders-05).
-- Reversal: 0106_futures_entry_protection.down.sql
--
-- One row per opening order that asked for protection, keyed by the order's own client id. The row is written before
-- the order is placed, so an order is never live with its protection unrecorded (the same request sent again finds
-- it). The conditional job arms a linked pair of part legs on the position the order's fills land in, sized to what
-- has settled there, and grows them as more settles: waiting (nothing filled yet), armed (legs cover the fills; the
-- order may fill more), done (the order is over and its legs were armed), not_filled (the order ended with no fill),
-- no_position (the order is over and nothing was open on its side to protect), not_placed (no order appeared under
-- the id; the same request sent again reopens it). armed_quantity is the order's settled fills the job has dealt with;
-- position_id is the position the newest legs are on, and earlier_quantity the fills dealt with before its newest
-- pair. generation counts the fresh pairs armed on that position after a leg of the last one fired (0: the first).
CREATE TABLE IF NOT EXISTS "trade"."futures_entry_protection" (
  "id"               uuid            PRIMARY KEY,
  "user_id"          text            NOT NULL,
  "market_id"        uuid            NOT NULL REFERENCES "trade"."markets" ("id"),
  "client_order_id"  text            NOT NULL,
  "side"             text            NOT NULL,
  "take_profit"      numeric(38, 18),
  "stop_loss"        numeric(38, 18),
  "request_hash"     text            NOT NULL,
  "status"           text            NOT NULL DEFAULT 'waiting',
  "armed_quantity"   numeric(38, 18) NOT NULL DEFAULT 0,
  "position_id"      uuid,
  "earlier_quantity" numeric(38, 18) NOT NULL DEFAULT 0,
  "generation"       integer         NOT NULL DEFAULT 0,
  "created_at"       timestamptz     NOT NULL DEFAULT now(),
  "updated_at"       timestamptz     NOT NULL DEFAULT now(),
  CONSTRAINT "futures_entry_protection_order_uq" UNIQUE ("user_id", "market_id", "client_order_id"),
  CONSTRAINT "futures_entry_protection_side_ck" CHECK ("side" IN ('buy', 'sell')),
  CONSTRAINT "futures_entry_protection_status_ck" CHECK (
    "status" IN ('waiting', 'armed', 'done', 'not_filled', 'no_position', 'not_placed')
  ),
  CONSTRAINT "futures_entry_protection_legs_ck" CHECK ("take_profit" IS NOT NULL OR "stop_loss" IS NOT NULL),
  CONSTRAINT "futures_entry_protection_prices_ck" CHECK (
    ("take_profit" IS NULL OR "take_profit" > 0) AND ("stop_loss" IS NULL OR "stop_loss" > 0)
  ),
  CONSTRAINT "futures_entry_protection_generation_ck" CHECK ("generation" >= 0),
  CONSTRAINT "futures_entry_protection_armed_ck" CHECK (
    "armed_quantity" >= 0 AND "earlier_quantity" >= 0 AND "earlier_quantity" <= "armed_quantity"
  )
);

CREATE INDEX IF NOT EXISTS "futures_entry_protection_live_idx"
  ON "trade"."futures_entry_protection" ("created_at")
  WHERE "status" IN ('waiting', 'armed');

CREATE INDEX IF NOT EXISTS "futures_entry_protection_user_idx"
  ON "trade"."futures_entry_protection" ("user_id", "created_at" DESC);
