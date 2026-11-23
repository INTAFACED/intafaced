-- intafaced:destructive — preserve known business history.
DO $$
BEGIN
  LOCK TABLE "ledger"."ledger_posted_keys" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "ledger"."ledger_posted_keys" WHERE TRUE) THEN
    RAISE EXCEPTION 'Cannot reverse 0017: posted key claims must be preserved';
  END IF;
DROP TRIGGER IF EXISTS "ledger_posted_keys_immutable" ON "ledger"."ledger_posted_keys";
DROP FUNCTION IF EXISTS "ledger"."ledger_posted_keys_immutable"();
DROP TABLE IF EXISTS "ledger"."ledger_posted_keys";

END $$;
