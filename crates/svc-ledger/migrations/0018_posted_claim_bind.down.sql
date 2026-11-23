-- intafaced:destructive — preserve known business history.
DO $$
BEGIN
  LOCK TABLE "ledger"."ledger_posted_keys" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "ledger"."ledger_posted_keys") THEN
    RAISE EXCEPTION 'Cannot reverse 0018: posted claim identity must be preserved';
  END IF;
  ALTER TABLE "ledger"."ledger_posted_keys" DROP COLUMN "posted_meta", DROP COLUMN "posted_hash";
END $$;
