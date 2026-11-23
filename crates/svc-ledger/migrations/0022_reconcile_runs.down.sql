-- intafaced:destructive — reversal of 0022_reconcile_runs.sql
--
-- Dropping this table discards the record of when the book was last proved.
-- With no ok run on file the staleness backstop has nothing to measure from.
-- Refuse rather than silently drop that history.
--
-- The count and the drop are one statement. SHARE ROW EXCLUSIVE is taken
-- before the count and held until the statement ends, so a run cannot commit
-- after the count returns 0 and before DROP TABLE.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."reconcile_runs" IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) INTO n FROM "ledger"."reconcile_runs";

  IF n > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse 0022: % recorded reconciliation run(s). Proof history must be preserved.',
      n;
  END IF;

  DROP INDEX IF EXISTS "ledger"."reconcile_runs_ok_idx";
  DROP TABLE "ledger"."reconcile_runs";
END $$;
