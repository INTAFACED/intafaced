-- svc-ops · a period whose latest run compared no record reads NOTHING_TO_COMPARE, never green (OWNER 288)
-- Reversal: 20261110103023_reconciliation_nothing_to_compare.down.sql
ALTER TABLE ops.reconciliation_periods DROP CONSTRAINT IF EXISTS reconciliation_periods_last_status_check;
ALTER TABLE ops.reconciliation_periods
  ADD CONSTRAINT reconciliation_periods_last_status_check
  CHECK (last_status IN ('PASS', 'FAIL', 'ERROR', 'UNSET', 'NOTHING_TO_COMPARE'));
