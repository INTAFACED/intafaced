-- intafaced:destructive — reversal of 0027_reconciliation_controls.sql
-- Refuses while an operator control or any run exists. Built-in rows are the seed.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."reconciliation_controls" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO n FROM "ledger"."reconciliation_controls" WHERE "builtin" = false;
  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 0027: % operator reconciliation control(s) exist.', n;
  END IF;
  SELECT count(*) INTO n FROM "ledger"."reconciliation_control_runs";
  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 0027: % reconciliation control run(s) exist.', n;
  END IF;

  DROP TRIGGER IF EXISTS "reconciliation_control_runs_no_truncate" ON "ledger"."reconciliation_control_runs";
  DROP TRIGGER IF EXISTS "reconciliation_control_runs_no_delete" ON "ledger"."reconciliation_control_runs";
  DROP FUNCTION IF EXISTS "ledger"."reconciliation_control_runs_no_delete"();
  DROP TRIGGER IF EXISTS "reconciliation_control_audit_no_truncate" ON "ledger"."reconciliation_control_audit";
  DROP TRIGGER IF EXISTS "reconciliation_control_audit_append_only" ON "ledger"."reconciliation_control_audit";
  DROP FUNCTION IF EXISTS "ledger"."reconciliation_control_audit_append_only"();
  DROP TRIGGER IF EXISTS "reconciliation_controls_no_truncate" ON "ledger"."reconciliation_controls";
  DROP TRIGGER IF EXISTS "reconciliation_controls_no_delete" ON "ledger"."reconciliation_controls";
  DROP FUNCTION IF EXISTS "ledger"."reconciliation_controls_no_delete"();
  DROP TABLE "ledger"."reconciliation_control_runs";
  DROP TABLE "ledger"."reconciliation_control_audit";
  DROP TABLE "ledger"."reconciliation_controls";
END $$;
