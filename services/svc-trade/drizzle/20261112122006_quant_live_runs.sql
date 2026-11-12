-- trade.quant_live_runs, trade.quant_live_run_orders, trade.quant_live_run_events · a live strategy run, the orders it
-- placed on the person's own venue sub-account, and its log (J-algo-dev-07; src/quant/live-run/live-runs.ts).
-- Reversal: 20261112122006_quant_live_runs.down.sql
--
-- These rows are what INTAFACED did for the run, never money: the venue is the record of the sub-account's cash,
-- positions and fills, and the ledger posts nothing. An order row is written under its run's next sequence number,
-- with the run's row lock held, before the run's key signs it; a number once taken is never taken again. The log holds
-- no key, balance or strategy source. Amounts are canonical decimal strings.

CREATE TABLE IF NOT EXISTS trade.quant_live_runs (
  user_id text NOT NULL CONSTRAINT quant_live_runs_user_ck CHECK (length(btrim(user_id)) > 0),
  run_id uuid NOT NULL,
  -- svc-quant's id and version of the person's strategy: opaque here, never a join.
  strategy_id text NOT NULL,
  strategy_version integer NOT NULL CONSTRAINT quant_live_runs_version_ck CHECK (strategy_version > 0),
  strategy_name text NOT NULL,
  venue_id text NOT NULL,
  -- The region the person started the run from; each supervisor pass checks trading is still allowed there.
  region text NOT NULL CONSTRAINT quant_live_runs_region_ck CHECK (length(btrim(region)) > 0),
  owner text NOT NULL CONSTRAINT quant_live_runs_owner_ck CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  sub_account text NOT NULL CONSTRAINT quant_live_runs_sub_ck CHECK (sub_account ~ '^0x[0-9a-f]{40}$'),
  agent_address text NOT NULL CONSTRAINT quant_live_runs_agent_ck CHECK (agent_address ~ '^0x[0-9a-f]{40}$'),
  asset text NOT NULL,
  cap text NOT NULL CONSTRAINT quant_live_runs_cap_ck CHECK (cap ~ '^[0-9]+(\.[0-9]+)?$' AND cap !~ '^0+(\.0+)?$'),
  -- The strategy version's order blocks as read at the start: [{ side, symbol, qty }], qty a decimal string.
  plan jsonb NOT NULL,
  restart_attempts integer NOT NULL CONSTRAINT quant_live_runs_attempts_ck CHECK (restart_attempts BETWEEN 0 AND 10),
  state_policy text NOT NULL CONSTRAINT quant_live_runs_policy_ck CHECK (state_policy IN ('keep', 'drop')),
  live_control boolean NOT NULL,
  state text NOT NULL CONSTRAINT quant_live_runs_state_ck
    CHECK (state IN ('signing', 'running', 'unknown', 'stopped', 'flat', 'ended', 'abandoned')),
  end_reason text CONSTRAINT quant_live_runs_reason_ck
    CHECK (end_reason IS NULL OR end_reason IN ('user_stop', 'liquidated', 'attempts_exhausted', 'account_frozen')),
  permission text NOT NULL CONSTRAINT quant_live_runs_permission_ck CHECK (permission IN ('signing', 'active', 'revoked')),
  restarts integer NOT NULL DEFAULT 0 CONSTRAINT quant_live_runs_restarts_ck CHECK (restarts >= 0 AND restarts <= restart_attempts),
  next_seq integer NOT NULL DEFAULT 1 CONSTRAINT quant_live_runs_seq_ck CHECK (next_seq >= 1),
  strategy_state jsonb NOT NULL,
  heartbeat_at timestamptz,
  stop_seq integer,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  stopped_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, run_id)
);

-- One key per run, ever: an address is never approved twice.
CREATE UNIQUE INDEX IF NOT EXISTS quant_live_runs_agent_uq ON trade.quant_live_runs (agent_address);
-- The supervisor's list: every run a process should be running or reconciling.
CREATE INDEX IF NOT EXISTS quant_live_runs_active_ix ON trade.quant_live_runs (state) WHERE state IN ('running', 'unknown');

CREATE TABLE IF NOT EXISTS trade.quant_live_run_orders (
  user_id text NOT NULL,
  run_id uuid NOT NULL,
  seq integer NOT NULL CONSTRAINT quant_live_run_orders_seq_ck CHECK (seq >= 1),
  action_key text NOT NULL CONSTRAINT quant_live_run_orders_key_ck CHECK (action_key ~ '^algo:(order|liquidate):'),
  kind text NOT NULL CONSTRAINT quant_live_run_orders_kind_ck CHECK (kind IN ('strategy', 'manual', 'liquidate')),
  block integer,
  symbol text NOT NULL,
  side text NOT NULL CONSTRAINT quant_live_run_orders_side_ck CHECK (side IN ('buy', 'sell')),
  order_type text NOT NULL CONSTRAINT quant_live_run_orders_type_ck CHECK (order_type IN ('market', 'limit')),
  size text NOT NULL CONSTRAINT quant_live_run_orders_size_ck CHECK (size ~ '^[0-9]+(\.[0-9]+)?$'),
  price text NOT NULL CONSTRAINT quant_live_run_orders_price_ck CHECK (price ~ '^[0-9]+(\.[0-9]+)?$'),
  reduce_only boolean NOT NULL,
  state text NOT NULL CONSTRAINT quant_live_run_orders_state_ck CHECK (state IN ('admitted', 'accepted', 'refused', 'unknown')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, run_id, seq),
  FOREIGN KEY (user_id, run_id) REFERENCES trade.quant_live_runs (user_id, run_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS quant_live_run_orders_key_uq ON trade.quant_live_run_orders (user_id, action_key);

CREATE TABLE IF NOT EXISTS trade.quant_live_run_events (
  user_id text NOT NULL,
  run_id uuid NOT NULL,
  n bigserial NOT NULL,
  at timestamptz NOT NULL,
  kind text NOT NULL,
  detail text NOT NULL,
  PRIMARY KEY (user_id, run_id, n),
  FOREIGN KEY (user_id, run_id) REFERENCES trade.quant_live_runs (user_id, run_id)
);
