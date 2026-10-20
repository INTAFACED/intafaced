-- Versioned owner fee schedule (SP-fees-vip-01 / SP-ops-02). One row per approved version, append-only.
-- The version in force for an order is the latest row whose effective_at is at or before the order's created_at,
-- so a new version never re-prices an order that was already placed. No row: the TRADE_FEE_SCHEDULE env value applies.
-- Reversal: 0083_fee_schedule_versions.down.sql

CREATE TABLE IF NOT EXISTS trade.fee_schedule_versions (
  id uuid PRIMARY KEY,
  version bigint NOT NULL CHECK (version >= 1) UNIQUE,
  schedule jsonb NOT NULL,
  effective_at timestamptz NOT NULL,
  operator_id text NOT NULL,
  approver_id text NOT NULL,
  reason text NOT NULL,
  approval_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS fee_schedule_versions_effective_idx
  ON trade.fee_schedule_versions (effective_at DESC, version DESC);

DROP TRIGGER IF EXISTS fee_schedule_versions_append_only ON trade.fee_schedule_versions;
CREATE TRIGGER fee_schedule_versions_append_only
  BEFORE UPDATE OR DELETE ON trade.fee_schedule_versions
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();
