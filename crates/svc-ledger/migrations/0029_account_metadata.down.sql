-- intafaced:destructive — reversal of 0029_account_metadata.sql
--
-- `account_metadata_changes` is the record of who set or deleted which key, and the access log is append-only.
-- Refuse while any change or any metadata read row exists rather than drop that history.

DO $$
DECLARE
  changes bigint;
  reads bigint;
BEGIN
  LOCK TABLE "ledger"."account_metadata_changes" IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE "ledger"."operator_access_log" IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) INTO changes FROM "ledger"."account_metadata_changes";
  SELECT count(*) INTO reads FROM "ledger"."operator_access_log" WHERE action = 'account_metadata.read';

  IF changes > 0 OR reads > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 0029: % metadata change(s) and % metadata read row(s). That history must be preserved.', changes, reads;
  END IF;

  DROP TRIGGER IF EXISTS "account_metadata_changes_no_truncate" ON "ledger"."account_metadata_changes";
  DROP TRIGGER IF EXISTS "account_metadata_changes_append_only" ON "ledger"."account_metadata_changes";
  DROP FUNCTION IF EXISTS "ledger"."account_metadata_changes_append_only"();
  DROP TABLE "ledger"."account_metadata_changes";
  DROP TABLE "ledger"."account_metadata";

  ALTER TABLE "ledger"."operator_access_log" DROP CONSTRAINT "operator_access_log_action_ck";
  ALTER TABLE "ledger"."operator_access_log"
    ADD CONSTRAINT "operator_access_log_action_ck"
    CHECK (action IN ('owner_balances.read', 'transaction.read', 'trace.read', 'transactions.list', 'accounts.search'));
END $$;
