-- Append-only market status transitions. History before this migration is unknown.
-- Reversal: 0057_market_status_history.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by TRADEOPSBE before this file was written.

CREATE OR REPLACE FUNCTION trade.operator_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operator record is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TABLE IF NOT EXISTS trade.market_status_history_origin (
  id integer PRIMARY KEY CHECK (id = 1),
  history_starts_at timestamptz NOT NULL
);

INSERT INTO trade.market_status_history_origin (id, history_starts_at)
VALUES (1, clock_timestamp())
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS trade.market_status_transitions (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL,
  from_status text NOT NULL,
  to_status text NOT NULL,
  operator_id text,
  approver_id text,
  reason text NOT NULL,
  occurred_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS market_status_transitions_market_idx
  ON trade.market_status_transitions (market_id, occurred_at, id);

DROP TRIGGER IF EXISTS market_status_transitions_append_only ON trade.market_status_transitions;
CREATE TRIGGER market_status_transitions_append_only
  BEFORE UPDATE OR DELETE ON trade.market_status_transitions
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();
