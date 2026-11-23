-- svc-ledger · a run that compared no record is NOTHING_TO_COMPARE, never PASS (OWNER 288, the honest reconcile)
-- Reversal: 20261110103023_reconcile_nothing_to_compare.down.sql
--
-- Widens the status check only. No row changes: a run stored before this keeps its status.
ALTER TABLE "ledger"."reconciliation_control_runs" DROP CONSTRAINT IF EXISTS "reconciliation_control_runs_status_ck";
ALTER TABLE "ledger"."reconciliation_control_runs"
  ADD CONSTRAINT "reconciliation_control_runs_status_ck"
  CHECK ("status" IN ('started', 'PASS', 'FAIL', 'ERROR', 'UNSET', 'NOTHING_TO_COMPARE'));
