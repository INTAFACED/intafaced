-- svc-ledger · the posted idempotency key stays claimed
-- Reversal: 0017_posted_key_lock.down.sql
--
-- 0016 refuses UPDATE of ledger_tx.idempotency_key. A role that can disable
-- that trigger can still retarget the column. verifyChain then goes red, but
-- the unique index no longer holds the original key, so a later post of that
-- key inserts a second movement before anyone reads the broken chain.
--
-- This table is the claim. It is inserted in the same transaction as the
-- journal row. Rewriting ledger_tx.idempotency_key does not free it. UPDATE
-- and DELETE are refused. It is not a second book: it stores no balance.

CREATE TABLE IF NOT EXISTS "ledger"."ledger_posted_keys" (
  "idempotency_key" text PRIMARY KEY,
  "tx_id" uuid NOT NULL REFERENCES "ledger"."ledger_tx"("id")
);

CREATE UNIQUE INDEX "ledger_posted_keys_tx_idx" ON "ledger"."ledger_posted_keys" ("tx_id");

INSERT INTO "ledger"."ledger_posted_keys" ("idempotency_key", "tx_id")
SELECT "idempotency_key", "id" FROM "ledger"."ledger_tx"
ON CONFLICT ("idempotency_key") DO NOTHING;

CREATE OR REPLACE FUNCTION "ledger"."ledger_posted_keys_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_posted_keys is append-only'
    USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS "ledger_posted_keys_immutable" ON "ledger"."ledger_posted_keys";
CREATE TRIGGER "ledger_posted_keys_immutable"
  BEFORE UPDATE OR DELETE ON "ledger"."ledger_posted_keys"
  FOR EACH ROW
  EXECUTE FUNCTION "ledger"."ledger_posted_keys_immutable"();
