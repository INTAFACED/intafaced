-- Operator export jobs (orders, fills, positions). The CSV is written once.
-- Reversal: 0056_operator_exports.down.sql
-- Number reserved in runs/MIGRATION-NUMBERS.md by TRADEOPSBE before this file was written.

CREATE OR REPLACE FUNCTION trade.operator_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operator record is append-only' USING ERRCODE = '23514';
END;
$$;

CREATE TABLE IF NOT EXISTS trade.operator_export_jobs (
  id uuid PRIMARY KEY,
  client_request_id text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('orders', 'fills', 'positions')),
  filters jsonb NOT NULL,
  csv text NOT NULL,
  row_count integer NOT NULL CHECK (row_count >= 0),
  operator_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

DROP TRIGGER IF EXISTS operator_export_jobs_append_only ON trade.operator_export_jobs;
CREATE TRIGGER operator_export_jobs_append_only
  BEFORE UPDATE OR DELETE ON trade.operator_export_jobs
  FOR EACH ROW EXECUTE FUNCTION trade.operator_append_only();
