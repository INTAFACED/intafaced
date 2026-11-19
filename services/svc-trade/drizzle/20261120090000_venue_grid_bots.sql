-- trade.venue_grid_bots, trade.venue_grid_orders · the spot grid bot on the person's own venue account (J-copy-bots-otc-14
-- on the venue, OWNER 226; src/grid/venue-grid.ts). Reversal: 20261120090000_venue_grid_bots.down.sql
--
-- Nothing here is a balance. The person's coins, the venue's locks on them and every fill are the venue's own record, read
-- from it. venue_grid_bots says what the bot is and which venue account it trades: the person's own (owner), under the
-- grid agent permission their wallet signed for agent_address, which can place and cancel orders and never withdraw.
-- venue_grid_orders names each venue order the bot placed by its business key (order_key, from which the venue's client
-- order id derives), and keeps what the bot last read of it from the venue: its state, what filled and the fees charged.

CREATE TABLE IF NOT EXISTS trade.venue_grid_bots (
  bot_id            text PRIMARY KEY,
  user_id           text NOT NULL,
  client_request_id text NOT NULL,
  request_hash      text NOT NULL,
  venue_id          text NOT NULL,
  owner             text NOT NULL,
  agent_address     text NOT NULL,
  region            text NOT NULL,
  symbol            text NOT NULL,
  base_asset        text NOT NULL,
  quote_asset       text NOT NULL,
  lower_price       numeric(38, 18) NOT NULL,
  upper_price       numeric(38, 18) NOT NULL,
  grid_count        integer NOT NULL,
  investment        numeric(38, 18) NOT NULL,
  levels            jsonb NOT NULL,
  status            text NOT NULL,
  status_reason     text,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT venue_grid_bots_request_uq UNIQUE (user_id, client_request_id),
  CONSTRAINT venue_grid_bots_bounds_ck CHECK (lower_price > 0 AND lower_price < upper_price),
  CONSTRAINT venue_grid_bots_count_ck CHECK (grid_count >= 2),
  CONSTRAINT venue_grid_bots_investment_ck CHECK (investment > 0),
  CONSTRAINT venue_grid_bots_status_ck CHECK (status IN ('signing', 'initializing', 'running', 'paused_range', 'stopped'))
);

CREATE INDEX IF NOT EXISTS venue_grid_bots_user_idx ON trade.venue_grid_bots (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS venue_grid_bots_live_idx ON trade.venue_grid_bots (status)
  WHERE status IN ('initializing', 'running', 'paused_range');

CREATE TABLE IF NOT EXISTS trade.venue_grid_orders (
  order_key   text PRIMARY KEY,
  bot_id      text NOT NULL REFERENCES trade.venue_grid_bots (bot_id),
  level_index integer NOT NULL,
  side        text NOT NULL,
  cycle       integer NOT NULL,
  price       numeric(38, 18) NOT NULL,
  qty         numeric(38, 18) NOT NULL,
  status      text NOT NULL,
  filled      numeric(38, 18) NOT NULL DEFAULT 0,
  venue_fee   numeric(38, 18) NOT NULL DEFAULT 0,
  builder_fee numeric(38, 18) NOT NULL DEFAULT 0,
  fee_asset   text,
  pair_profit numeric(38, 18),
  placed_at   timestamptz NOT NULL,
  closed_at   timestamptz,
  CONSTRAINT venue_grid_orders_pair_uq UNIQUE (bot_id, level_index, side, cycle),
  CONSTRAINT venue_grid_orders_side_ck CHECK (side IN ('buy', 'sell')),
  CONSTRAINT venue_grid_orders_status_ck CHECK (status IN ('open', 'filled', 'partial', 'cancelled', 'refused')),
  CONSTRAINT venue_grid_orders_key_ck CHECK (order_key LIKE 'grid:' || bot_id || ':%')
);

CREATE INDEX IF NOT EXISTS venue_grid_orders_bot_idx ON trade.venue_grid_orders (bot_id, placed_at);
