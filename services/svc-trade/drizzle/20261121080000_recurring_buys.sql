-- trade.recurring_buy_rules, trade.recurring_buy_slots, trade.recurring_buy_orders · a recurring buy of a basket on the
-- person's own venue account (J-copy-bots-otc-16, OWNER 226; src/recurring/recurring-buys.ts). Reversal:
-- 20261121080000_recurring_buys.down.sql
--
-- Nothing here is a balance. The person's coins and every fill are the venue's own record, read from it. A rule says what
-- to buy, how often and for how much, on which venue account (the person's own, owner), under the recurring-buy agent
-- permission their wallet signed for agent_address, which can place and cancel orders and never withdraw. A slot row is
-- written before its orders are signed, so a crash re-runs the same slot under the same keys. An order row names one
-- venue order by its business key and keeps what was last read of it from the venue.

CREATE TABLE IF NOT EXISTS trade.recurring_buy_rules (
  rule_id           text PRIMARY KEY,
  user_id           text NOT NULL,
  client_request_id text NOT NULL,
  request_hash      text NOT NULL,
  venue_id          text NOT NULL,
  owner             text NOT NULL,
  agent_address     text NOT NULL,
  region            text NOT NULL,
  quote_asset       text NOT NULL,
  basket            jsonb NOT NULL,
  amount            numeric(38, 18) NOT NULL,
  frequency         text NOT NULL,
  max_investment    numeric(38, 18),
  status            text NOT NULL,
  status_reason     text,
  next_run_at       timestamptz,
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  CONSTRAINT recurring_buy_rules_request_uq UNIQUE (user_id, client_request_id),
  CONSTRAINT recurring_buy_rules_amount_ck CHECK (amount > 0),
  CONSTRAINT recurring_buy_rules_max_ck CHECK (max_investment IS NULL OR max_investment > 0),
  CONSTRAINT recurring_buy_rules_frequency_ck CHECK (frequency IN ('hourly', 'daily', 'weekly')),
  CONSTRAINT recurring_buy_rules_status_ck
    CHECK (status IN ('signing', 'active', 'suspended_insufficient_funds', 'completed', 'terminated'))
);

CREATE INDEX IF NOT EXISTS recurring_buy_rules_user_idx ON trade.recurring_buy_rules (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recurring_buy_rules_live_idx ON trade.recurring_buy_rules (status)
  WHERE status IN ('active', 'suspended_insufficient_funds');

CREATE TABLE IF NOT EXISTS trade.recurring_buy_slots (
  rule_id text NOT NULL REFERENCES trade.recurring_buy_rules (rule_id),
  slot    integer NOT NULL,
  amount  numeric(38, 18) NOT NULL,
  outcome text NOT NULL,
  at      timestamptz NOT NULL,
  PRIMARY KEY (rule_id, slot),
  CONSTRAINT recurring_buy_slots_amount_ck CHECK (amount > 0),
  CONSTRAINT recurring_buy_slots_outcome_ck
    CHECK (outcome IN ('pending', 'bought', 'skipped_insufficient_funds', 'skipped_not_permitted'))
);

CREATE TABLE IF NOT EXISTS trade.recurring_buy_orders (
  order_key   text PRIMARY KEY,
  rule_id     text NOT NULL REFERENCES trade.recurring_buy_rules (rule_id),
  slot        integer,
  kind        text NOT NULL,
  symbol      text NOT NULL,
  price       numeric(38, 18) NOT NULL,
  qty         numeric(38, 18) NOT NULL,
  status      text NOT NULL,
  filled      numeric(38, 18) NOT NULL DEFAULT 0,
  quote       numeric(38, 18) NOT NULL DEFAULT 0,
  venue_fee   numeric(38, 18) NOT NULL DEFAULT 0,
  builder_fee numeric(38, 18) NOT NULL DEFAULT 0,
  fee_asset   text,
  placed_at   timestamptz NOT NULL,
  closed_at   timestamptz,
  CONSTRAINT recurring_buy_orders_kind_ck CHECK (kind IN ('buy', 'convert')),
  CONSTRAINT recurring_buy_orders_slot_ck CHECK ((kind = 'buy') = (slot IS NOT NULL)),
  CONSTRAINT recurring_buy_orders_status_ck
    CHECK (status IN ('open', 'filled', 'partial', 'cancelled', 'refused', 'skipped_price_range')),
  CONSTRAINT recurring_buy_orders_key_ck CHECK (order_key LIKE 'recurring:' || rule_id || ':%')
);

CREATE INDEX IF NOT EXISTS recurring_buy_orders_rule_idx ON trade.recurring_buy_orders (rule_id, placed_at);
