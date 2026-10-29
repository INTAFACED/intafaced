-- trade.grid · spot grid bots, their reserve and their level orders (CB-bots-02, CB-bots-10; J-copy-bots-otc-14)
-- Reversal: 20261029154541_grid_bots.down.sql
--
-- grid_bots: one row per bot. The id comes from the owner's request key, so a second create with the same key finds
-- this row instead of writing another. levels is the plan fixed at create (price, quantity and hold per
-- level, decimal strings), so a later tick never re-derives it from a changed market. place_grant holds the claims presented at create (never a token or secret).
--
-- grid_bot_reserves: the most the bot may use of the owner's free quote balance (its investment). A svc-trade limit
-- row, not a balance and not a ledger hold: nothing posts when it is written or released, and every level order takes
-- its own order hold. Business key bots.grid.reserve:<bot_id>. Released when the bot fails to start or stops; the row
-- stays as the record.
--
-- grid_bot_orders: each level order the bot placed, keyed by the trade order's clientOrderId. A filled sell carries
-- its pair's profit net of fees.

CREATE TABLE IF NOT EXISTS "trade"."grid_bots" (
  "bot_id"            text PRIMARY KEY,
  "user_id"           text NOT NULL,
  "client_request_id" text NOT NULL,
  "request_hash"      text NOT NULL,
  "market_id"         text NOT NULL,
  "symbol"            text NOT NULL,
  "base_asset"        text NOT NULL,
  "quote_asset"       text NOT NULL,
  "lower_price"       numeric(38, 18) NOT NULL,
  "upper_price"       numeric(38, 18) NOT NULL,
  "grid_count"        integer NOT NULL,
  "investment"        numeric(38, 18) NOT NULL,
  "levels"            jsonb NOT NULL,
  "status"            text NOT NULL,
  "status_reason"     text,
  "place_grant"       jsonb NOT NULL,
  "created_at"        timestamptz NOT NULL,
  "updated_at"        timestamptz NOT NULL,
  CONSTRAINT "grid_bots_request_uq" UNIQUE ("user_id", "client_request_id"),
  CONSTRAINT "grid_bots_bounds_ck" CHECK ("lower_price" > 0 AND "lower_price" < "upper_price"),
  CONSTRAINT "grid_bots_count_ck" CHECK ("grid_count" >= 2),
  CONSTRAINT "grid_bots_investment_ck" CHECK ("investment" > 0),
  CONSTRAINT "grid_bots_status_ck" CHECK ("status" IN ('running', 'paused_range', 'initialization_failed', 'stopped'))
);

CREATE INDEX IF NOT EXISTS "grid_bots_user_idx" ON "trade"."grid_bots" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "grid_bots_live_idx" ON "trade"."grid_bots" ("status") WHERE "status" IN ('running', 'paused_range');

CREATE TABLE IF NOT EXISTS "trade"."grid_bot_reserves" (
  "reserve_key" text PRIMARY KEY,
  "bot_id"      text NOT NULL UNIQUE REFERENCES "trade"."grid_bots" ("bot_id"),
  "user_id"     text NOT NULL,
  "asset"       text NOT NULL,
  "amount"      numeric(38, 18) NOT NULL,
  "held_at"     timestamptz NOT NULL,
  "released_at" timestamptz,
  CONSTRAINT "grid_bot_reserves_key_ck" CHECK ("reserve_key" = 'bots.grid.reserve:' || "bot_id"),
  CONSTRAINT "grid_bot_reserves_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "grid_bot_reserves_release_ck" CHECK ("released_at" IS NULL OR "released_at" >= "held_at")
);

CREATE INDEX IF NOT EXISTS "grid_bot_reserves_held_idx"
  ON "trade"."grid_bot_reserves" ("user_id", "asset")
  WHERE "released_at" IS NULL;

CREATE TABLE IF NOT EXISTS "trade"."grid_bot_orders" (
  "client_order_id" text PRIMARY KEY,
  "bot_id"          text NOT NULL REFERENCES "trade"."grid_bots" ("bot_id"),
  "level_index"     integer NOT NULL,
  "side"            text NOT NULL,
  "cycle"           integer NOT NULL,
  "order_id"        text NOT NULL,
  "price"           numeric(38, 18) NOT NULL,
  "qty"             numeric(38, 18) NOT NULL,
  "order_hold"     numeric(38, 18) NOT NULL,
  "status"          text NOT NULL,
  "pair_profit"     numeric(38, 18),
  "placed_at"       timestamptz NOT NULL,
  "closed_at"       timestamptz,
  CONSTRAINT "grid_bot_orders_pair_uq" UNIQUE ("bot_id", "level_index", "side", "cycle"),
  CONSTRAINT "grid_bot_orders_side_ck" CHECK ("side" IN ('buy', 'sell')),
  CONSTRAINT "grid_bot_orders_status_ck" CHECK ("status" IN ('open', 'filled', 'cancelled')),
  CONSTRAINT "grid_bot_orders_profit_ck" CHECK ("pair_profit" IS NULL OR ("side" = 'sell' AND "status" = 'filled')),
  CONSTRAINT "grid_bot_orders_key_ck" CHECK ("client_order_id" LIKE 'grid:' || "bot_id" || ':%')
);

CREATE INDEX IF NOT EXISTS "grid_bot_orders_open_idx" ON "trade"."grid_bot_orders" ("bot_id") WHERE "status" = 'open';
