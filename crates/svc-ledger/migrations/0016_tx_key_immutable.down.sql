-- intafaced:destructive — preserve known business history.
DO $$
BEGIN
  LOCK TABLE "ledger"."ledger_tx" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "ledger"."ledger_tx" WHERE TRUE) THEN
    RAISE EXCEPTION 'Cannot reverse 0016: posted transaction identity must be preserved';
  END IF;
DROP TRIGGER IF EXISTS "ledger_tx_key_immutable" ON "ledger"."ledger_tx";
DROP FUNCTION IF EXISTS "ledger"."ledger_tx_key_immutable"();

END $$;
