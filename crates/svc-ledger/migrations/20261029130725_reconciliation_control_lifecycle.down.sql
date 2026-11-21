-- intafaced:destructive — reversal of 20261029130725_reconciliation_control_lifecycle.sql
-- Refuses while any control is paused or retired: narrowing the check would otherwise fail or lose that state.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."reconciliation_controls" IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) INTO n FROM "ledger"."reconciliation_controls" WHERE "state" IN ('paused', 'retired');
  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 20261029130725_reconciliation_control_lifecycle: % reconciliation control(s) are paused or retired.', n;
  END IF;
  ALTER TABLE "ledger"."reconciliation_controls"
    DROP CONSTRAINT "reconciliation_controls_state_ck",
    ADD CONSTRAINT "reconciliation_controls_state_ck" CHECK ("state" IN ('draft', 'active'));
  ALTER TABLE "ledger"."reconciliation_controls" DROP COLUMN "resumed_at";
END $$;
