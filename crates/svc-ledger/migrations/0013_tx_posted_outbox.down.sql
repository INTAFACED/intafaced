-- intafaced:destructive — reversal of 0013_tx_posted_outbox.sql
--
-- Dropping this table discards unpublished publish intent. A movement already
-- in ledger_tx would then have no durable record that `ledgerTxPosted` still
-- needs to leave the process. Refuse rather than silently drop that queue.
--
-- The count and the drop are one statement. SHARE ROW EXCLUSIVE is taken
-- before the count and held until the statement ends, so a post cannot commit
-- an unpublished row after the count returns 0 and before DROP TABLE. A later
-- statement would release that lock on autocommit, which is the same gap.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."ledger_tx_outbox" IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) INTO n
    FROM "ledger"."ledger_tx_outbox"
   WHERE "published_at" IS NULL;

  IF n > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse 0013: % unpublished ledgerTxPosted outbox row(s). Publish or mark them sent first — dropping the table would forget that the book moved and the bus did not.',
      n;
  END IF;

  DROP INDEX IF EXISTS "ledger"."ledger_tx_outbox_unpublished_idx";
  DROP INDEX IF EXISTS "ledger"."ledger_tx_outbox_tx_idx";
  DROP TABLE "ledger"."ledger_tx_outbox";
END $$;
