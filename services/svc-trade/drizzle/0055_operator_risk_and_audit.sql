-- Operator risk-limit history and the append-only audit the trade desk reads.
-- Reversal: 0055_operator_risk_and_audit.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by TRADEOPSBE before this file was written.
-- Audit, idempotency, market-maker seed and reconcile-sweep rows live here too:
-- the job reserved three svc-trade numbers (0055 risk, 0056 exports, 0057 status history).

CREATE OR REPLACE FUNCTION trade.operator_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operator record is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TABLE IF NOT EXISTS trade.operator_audit (
  id uuid PRIMARY KEY,
  kind text NOT NULL,
  operator_id text NOT NULL,
  account_id text,
  object_id text NOT NULL,
  approver_id text,
  reason text,
  occurred_at timestamptz NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS operator_audit_feed_idx
  ON trade.operator_audit (occurred_at, id);

DROP TRIGGER IF EXISTS operator_audit_append_only ON trade.operator_audit;
CREATE TRIGGER operator_audit_append_only
  BEFORE UPDATE OR DELETE ON trade.operator_audit
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

CREATE TABLE IF NOT EXISTS trade.operator_requests (
  client_request_id text PRIMARY KEY,
  kind text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS operator_requests_append_only ON trade.operator_requests;
CREATE TRIGGER operator_requests_append_only
  BEFORE UPDATE OR DELETE ON trade.operator_requests
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- One row per version. The current limit is the highest version. Blank fields stay NULL.
CREATE TABLE IF NOT EXISTS trade.operator_risk_limits (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  collar text,
  fat_finger text,
  slippage_cap text,
  throttle text,
  circuit_breaker text,
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  reason text NOT NULL,
  approval_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (market_id, version)
);

DROP TRIGGER IF EXISTS operator_risk_limits_append_only ON trade.operator_risk_limits;
CREATE TRIGGER operator_risk_limits_append_only
  BEFORE UPDATE OR DELETE ON trade.operator_risk_limits
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

-- Latest row wins. No row means the seed switch is off.
CREATE TABLE IF NOT EXISTS trade.operator_mm_seed (
  id uuid PRIMARY KEY,
  market_id uuid NOT NULL,
  version bigint NOT NULL CHECK (version >= 1),
  enabled boolean NOT NULL,
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  approval_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (market_id, version)
);

DROP TRIGGER IF EXISTS operator_mm_seed_append_only ON trade.operator_mm_seed;
CREATE TRIGGER operator_mm_seed_append_only
  BEFORE UPDATE OR DELETE ON trade.operator_mm_seed
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();

CREATE TABLE IF NOT EXISTS trade.operator_reconcile_sweeps (
  id uuid PRIMARY KEY,
  client_request_id text NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  result jsonb NOT NULL
);

DROP TRIGGER IF EXISTS operator_reconcile_sweeps_append_only ON trade.operator_reconcile_sweeps;
CREATE TRIGGER operator_reconcile_sweeps_append_only
  BEFORE UPDATE OR DELETE ON trade.operator_reconcile_sweeps
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();
