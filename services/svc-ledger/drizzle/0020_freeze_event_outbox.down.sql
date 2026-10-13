-- intafaced:destructive — reversal of 0020_freeze_event_outbox.sql
--
-- Dropping this table discards unpublished ledgerFreezeUpdated intent. The
-- switch would already have moved and the bus would never hear it. Refuse
-- rather than silently drop that queue.
--
-- The count and the drop are one statement. SHARE ROW EXCLUSIVE is taken
-- before the count and held until the statement ends, so a freeze cannot
-- commit an unpublished row after the count returns 0 and before DROP TABLE.

DO $$
DECLARE
  n bigint;
BEGIN
  LOCK TABLE "ledger"."ledger_freeze_outbox" IN SHARE ROW EXCLUSIVE MODE;

  SELECT count(*) INTO n
    FROM "ledger"."ledger_freeze_outbox"
;

  IF n > 0 THEN
    RAISE EXCEPTION
      'Cannot reverse 0020: % recorded ledgerFreezeUpdated outbox row(s). Recorded switch history must be preserved.',
      n;
  END IF;

  DROP INDEX IF EXISTS "ledger"."ledger_freeze_outbox_unpublished_idx";
  DROP INDEX IF EXISTS "ledger"."ledger_freeze_outbox_key_idx";
  DROP TABLE "ledger"."ledger_freeze_outbox";
END $$;
