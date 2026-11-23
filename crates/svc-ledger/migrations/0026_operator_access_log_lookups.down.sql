-- intafaced:destructive — reversal of 0026_operator_access_log_lookups.sql
--
-- Narrowing the action check would make every lookup row already written invalid, and the access log is
-- append-only: those rows must be kept. Refuse while any lookup row exists rather than lose that history.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."operator_access_log" IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) INTO n FROM "ledger"."operator_access_log" WHERE action <> 'owner_balances.read';

  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 0026: % transaction lookup row(s). Access history must be preserved.', n;
  END IF;

  ALTER TABLE "ledger"."operator_access_log" DROP CONSTRAINT "operator_access_log_action_ck";
  ALTER TABLE "ledger"."operator_access_log"
    ADD CONSTRAINT "operator_access_log_action_ck" CHECK (action IN ('owner_balances.read'));
END $$;
