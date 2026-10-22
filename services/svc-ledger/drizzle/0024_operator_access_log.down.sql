-- intafaced:destructive — reversal of 0024_operator_access_log.sql
--
-- Dropping this table discards the record of who read whose account detail.
-- Refuse while any row exists rather than silently drop that history.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."operator_access_log" IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) INTO n FROM "ledger"."operator_access_log";

  IF n > 0 THEN
    RAISE EXCEPTION 'Cannot reverse 0024: % operator access row(s). Access history must be preserved.', n;
  END IF;

  DROP TRIGGER IF EXISTS "operator_access_log_no_truncate" ON "ledger"."operator_access_log";
  DROP TRIGGER IF EXISTS "operator_access_log_append_only" ON "ledger"."operator_access_log";
  DROP FUNCTION IF EXISTS "ledger"."operator_access_log_append_only"();
  DROP INDEX IF EXISTS "ledger"."operator_access_log_target_idx";
  DROP TABLE "ledger"."operator_access_log";
END $$;
