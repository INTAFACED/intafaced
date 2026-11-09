-- svc-ops · reverse 20261108225501_capital_monitor.sql
DROP TABLE IF EXISTS ops.capital_breach_alerts;
DROP TABLE IF EXISTS ops.capital_thresholds;
DROP FUNCTION IF EXISTS ops.capital_append_only();
