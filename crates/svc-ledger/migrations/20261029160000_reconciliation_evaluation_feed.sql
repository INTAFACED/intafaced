-- svc-ledger · the reconciliation evaluation feed svc-ops reads (OPS-reconciliation-03)
-- Reversal: 20261029160000_reconciliation_evaluation_feed.down.sql
--
-- svc-ops reads finished evaluations in (finished_at, id) order from a cursor. No row changes.
CREATE INDEX IF NOT EXISTS "reconciliation_control_runs_finished_idx"
  ON "ledger"."reconciliation_control_runs" ("finished_at", "id")
  WHERE "finished_at" IS NOT NULL;
