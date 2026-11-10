-- Reverses 20261110103023_reconcile_nothing_to_compare.sql. Refuses while a NOTHING_TO_COMPARE run is stored, so no row
-- is rewritten to a status it never had.
ALTER TABLE "ledger"."reconciliation_control_runs" DROP CONSTRAINT IF EXISTS "reconciliation_control_runs_status_ck";
ALTER TABLE "ledger"."reconciliation_control_runs"
  ADD CONSTRAINT "reconciliation_control_runs_status_ck"
  CHECK ("status" IN ('started', 'PASS', 'FAIL', 'ERROR', 'UNSET'));
