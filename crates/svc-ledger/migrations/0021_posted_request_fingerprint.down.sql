-- intafaced:destructive — preserve known business history.
-- Reversal of 0021: drops the request digest. Refused while any digest is stored,
-- so a rollback cannot silently reopen the reused-key hole for booked keys.
DO $$
BEGIN
  LOCK TABLE "ledger"."ledger_posted_keys" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "ledger"."ledger_posted_keys" WHERE "request_fingerprint" IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot reverse 0021: stored request digests must be preserved';
  END IF;
  ALTER TABLE "ledger"."ledger_posted_keys" DROP COLUMN "request_fingerprint";
END $$;
