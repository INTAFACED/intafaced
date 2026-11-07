-- J-charts-desk-18 #2 (C-embed-feed-ops-03, C-ops-01): the feed event journal. One row per transition of a market's candle
-- stream, written only by svc-trade's feed watcher (`admin/feed-health.ts`): a `drop` when the stream passes the owner's
-- delayed boundary, a `reconnect` when a tick arrives after a drop. Append-only; the founder console reads it, nobody edits it.
CREATE TABLE IF NOT EXISTS trade.feed_events (
  id bigserial PRIMARY KEY,
  symbol text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 64),
  kind text NOT NULL CHECK (kind IN ('drop', 'reconnect')),
  at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  actor text NOT NULL CHECK (actor = 'system'),
  age_seconds integer NOT NULL CHECK (age_seconds >= 0),
  boundary_seconds integer NOT NULL CHECK (boundary_seconds > 0)
);

CREATE INDEX IF NOT EXISTS feed_events_symbol_id_idx ON trade.feed_events (symbol, id DESC);
