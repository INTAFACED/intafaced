-- J-cex-spot-20 #8 (RC-cex-spot-09, RC-cex-spot-06): the maker incentive programme's terms and members, its clawback
-- records, and the launch-liquidity plan per market. Terms, members and plans are written only under a second
-- operator's approval (svc-trade `admin/maker-programme.ts`); each write is one new version, never an edit in place.
-- Nothing here holds or moves value: capital figures are plan records, not balances. Period settlement, incentive
-- payment and clawback posting are a later change; until then nothing writes `maker_clawbacks`.

CREATE TABLE IF NOT EXISTS trade.maker_programme_terms (
  version bigint PRIMARY KEY CHECK (version > 0),
  -- [{ name, minMakerVolume30d, minUptimePct, maxSpreadAtDepthBps, rebateBps }], decimals as strings, at least one tier.
  tiers jsonb NOT NULL CHECK (jsonb_typeof(tiers) = 'array' AND jsonb_array_length(tiers) > 0),
  max_spread_bps integer NOT NULL CHECK (max_spread_bps > 0),
  min_depth numeric(38, 18) NOT NULL CHECK (min_depth > 0),
  min_uptime_pct numeric(7, 4) NOT NULL CHECK (min_uptime_pct > 0 AND min_uptime_pct <= 100),
  cancel_to_fill_ceiling numeric(38, 18) NOT NULL CHECK (cancel_to_fill_ceiling > 0),
  clawback_window_days integer NOT NULL CHECK (clawback_window_days > 0),
  equal_access_criteria text NOT NULL CHECK (length(btrim(equal_access_criteria)) > 0),
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per account, its latest admission; every version is also in trade.operator_audit.
CREATE TABLE IF NOT EXISTS trade.maker_programme_members (
  account_id uuid PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  tier text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'suspended', 'exited')),
  conflict_declaration text NOT NULL CHECK (length(btrim(conflict_declaration)) > 0),
  terms_version bigint NOT NULL REFERENCES trade.maker_programme_terms (version),
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A clawback of an incentive already paid, created by a later surveillance finding. Read here; written by the period
-- settlement change, which posts it through the ledger's fee recipe.
CREATE TABLE IF NOT EXISTS trade.maker_clawbacks (
  id uuid PRIMARY KEY,
  period text NOT NULL,
  account_id uuid NOT NULL,
  market_id uuid REFERENCES trade.markets (id),
  amount numeric(38, 18) NOT NULL CHECK (amount > 0),
  asset text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'posted')),
  finding_ref text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- One clawback per finding, period and account: the business key the settlement change writes under.
CREATE UNIQUE INDEX IF NOT EXISTS maker_clawbacks_finding_key ON trade.maker_clawbacks (period, account_id, finding_ref);
CREATE INDEX IF NOT EXISTS maker_clawbacks_created_idx ON trade.maker_clawbacks (created_at DESC);

CREATE TABLE IF NOT EXISTS trade.launch_liquidity_plans (
  market_id uuid NOT NULL REFERENCES trade.markets (id),
  version bigint NOT NULL CHECK (version > 0),
  state text NOT NULL CHECK (state IN ('draft', 'approved', 'active', 'exited')),
  -- [{ accountId, capital, asset }]: the programme's members who quote this market, and the capital each commits.
  makers jsonb NOT NULL CHECK (jsonb_typeof(makers) = 'array' AND jsonb_array_length(makers) > 0),
  max_spread_bps integer NOT NULL CHECK (max_spread_bps > 0),
  min_depth numeric(38, 18) NOT NULL CHECK (min_depth > 0),
  depth_band_bps integer NOT NULL CHECK (depth_band_bps > 0),
  min_uptime_pct numeric(7, 4) NOT NULL CHECK (min_uptime_pct > 0 AND min_uptime_pct <= 100),
  inventory_min numeric(38, 18) NOT NULL,
  inventory_max numeric(38, 18) NOT NULL,
  exit_review_date date NOT NULL,
  exit_uptime_below_pct numeric(7, 4) NOT NULL CHECK (exit_uptime_below_pct > 0 AND exit_uptime_below_pct <= 100),
  exit_spread_above_bps integer NOT NULL CHECK (exit_spread_above_bps > 0),
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (market_id, version),
  CHECK (inventory_min <= inventory_max)
);
