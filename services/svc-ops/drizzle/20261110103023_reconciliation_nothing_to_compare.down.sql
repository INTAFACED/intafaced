-- svc-ops · reverse 20261110103023_reconciliation_nothing_to_compare.sql (refuses while such a period is stored)
ALTER TABLE ops.reconciliation_periods DROP CONSTRAINT IF EXISTS reconciliation_periods_last_status_check;
ALTER TABLE ops.reconciliation_periods
  ADD CONSTRAINT reconciliation_periods_last_status_check
  CHECK (last_status IN ('PASS', 'FAIL', 'ERROR', 'UNSET'));
