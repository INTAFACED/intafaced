-- J-charts-desk-19 #2 #3 #4 (C-ops-03 (b)(c)): each market's chart feed control and its journal.
--
-- trade.chart_feed_state: one row per market symbol once an operator has changed it; a market with no row reads its
-- primary source (INTAFACED's own trade tape) and chart state `on`, at version 0. `source` is `primary` or a name from
-- the owner's fallback source list (TRADE_CHART_FEED_FALLBACK_SOURCES). `state` is one of three: on, disabled (the
-- chart feed refuses its candle read), delisted_with_history (the chart keeps its candles up to the delisting, none after).
-- Written only by svc-trade's `admin.chartFeedControls.run`, in the same transaction as its journal and audit rows.
--
-- trade.chart_feed_controls: the append-only journal of every applied change, with who proposed, who approved, who
-- applied, the approval spent, the reason and the time. The approval id is the business key: one change per approval.
-- Nothing here moves money. Reversal: 20261118213506_chart_feed_controls.down.sql
CREATE TABLE IF NOT EXISTS trade.chart_feed_state (
  symbol text PRIMARY KEY CHECK (char_length(symbol) BETWEEN 1 AND 64),
  source text NOT NULL CHECK (source ~ '^[a-z][a-z0-9_-]{0,31}$'),
  state text NOT NULL CHECK (state IN ('on', 'disabled', 'delisted_with_history')),
  version bigint NOT NULL CHECK (version >= 1),
  -- When the chart was marked delisted with history: the chart serves candles before this time only. Null otherwise.
  delisted_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT chart_feed_state_delisted_ck CHECK ((state = 'delisted_with_history') = (delisted_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS trade.chart_feed_controls (
  id bigserial PRIMARY KEY,
  symbol text NOT NULL CHECK (char_length(symbol) BETWEEN 1 AND 64),
  action text NOT NULL CHECK (action IN ('switch_source', 'disable', 'enable', 'delist_with_history')),
  from_source text NOT NULL,
  to_source text NOT NULL,
  from_state text NOT NULL CHECK (from_state IN ('on', 'disabled', 'delisted_with_history')),
  to_state text NOT NULL CHECK (to_state IN ('on', 'disabled', 'delisted_with_history')),
  version bigint NOT NULL CHECK (version >= 1),
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  proposer_id text NOT NULL,
  approver_id text NOT NULL,
  executor_id text NOT NULL,
  approval_id text NOT NULL,
  at timestamptz NOT NULL,
  CONSTRAINT chart_feed_controls_two_people_ck CHECK (lower(btrim(proposer_id)) <> lower(btrim(approver_id))),
  CONSTRAINT chart_feed_controls_approval_uq UNIQUE (approval_id),
  CONSTRAINT chart_feed_controls_version_uq UNIQUE (symbol, version)
);

CREATE INDEX IF NOT EXISTS chart_feed_controls_at_idx ON trade.chart_feed_controls (at, id);

DROP TRIGGER IF EXISTS chart_feed_controls_append_only ON "trade"."chart_feed_controls";
CREATE TRIGGER chart_feed_controls_append_only
  BEFORE UPDATE OR DELETE ON "trade"."chart_feed_controls"
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();
