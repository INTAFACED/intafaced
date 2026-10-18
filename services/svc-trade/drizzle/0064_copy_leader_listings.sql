-- trade.copy · operator-published leader directory (TRD-0026, TRD-0675, TRD-0662)
-- Reversal: 0064_copy_leader_listings.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by COPYLEADERS before this file was written.
--
-- A missing row is unlisted. The operator writes every field. published_return
-- and maximum_drawdown are exact decimal strings, never computed and never
-- floats. Audit and idempotency rows are append-only. The listing row itself
-- changes when an operator edits it or sets its state.

CREATE OR REPLACE FUNCTION trade.copy_leader_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'copy leader record is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TABLE IF NOT EXISTS trade.copy_leader_listings (
  leader_ref text PRIMARY KEY,
  leader_user_id text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'unlisted',
  display_name text NOT NULL,
  record_kind text NOT NULL,
  tenure_start timestamptz,
  assets jsonb NOT NULL,
  capacity integer,
  strategy_version text,
  published_return text,
  maximum_drawdown text,
  window_start timestamptz,
  window_end timestamptz,
  net_of_costs boolean,
  evidence_ref text,
  listed_at timestamptz,
  state_changed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT copy_leader_listings_state_ck
    CHECK (state IN ('unlisted', 'listed', 'suspended', 'delisted')),
  CONSTRAINT copy_leader_listings_kind_ck
    CHECK (record_kind IN ('verified_live', 'paper', 'backtest', 'imported', 'self_reported')),
  CONSTRAINT copy_leader_listings_capacity_ck
    CHECK (capacity IS NULL OR capacity >= 0),
  CONSTRAINT copy_leader_listings_verified_evidence_ck
    CHECK (record_kind <> 'verified_live' OR (evidence_ref IS NOT NULL AND length(btrim(evidence_ref)) > 0))
);

CREATE INDEX IF NOT EXISTS copy_leader_listings_listed_order_idx
  ON trade.copy_leader_listings (listed_at, leader_ref)
  WHERE state = 'listed';

CREATE TABLE IF NOT EXISTS trade.copy_leader_listing_audit (
  audit_id uuid PRIMARY KEY,
  operator_id text NOT NULL,
  leader_ref text NOT NULL,
  leader_user_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  action text NOT NULL,
  client_request_id text NOT NULL,
  reason text,
  detail jsonb NOT NULL
);

DROP TRIGGER IF EXISTS copy_leader_listing_audit_append_only ON trade.copy_leader_listing_audit;
CREATE TRIGGER copy_leader_listing_audit_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_leader_listing_audit
  FOR EACH ROW EXECUTE FUNCTION trade.copy_leader_append_only();

CREATE TABLE IF NOT EXISTS trade.copy_leader_ops_requests (
  client_request_id text PRIMARY KEY,
  kind text NOT NULL,
  fingerprint text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL
);

DROP TRIGGER IF EXISTS copy_leader_ops_requests_append_only ON trade.copy_leader_ops_requests;
CREATE TRIGGER copy_leader_ops_requests_append_only
  BEFORE UPDATE OR DELETE ON trade.copy_leader_ops_requests
  FOR EACH ROW EXECUTE FUNCTION trade.copy_leader_append_only();
