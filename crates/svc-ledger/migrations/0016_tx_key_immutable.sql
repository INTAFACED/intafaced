-- svc-ledger · the idempotency key and meta cannot be rewritten
-- Reversal: 0016_tx_key_immutable.down.sql
--
-- THE DEFECT
--
-- hashTx used to cover id, module, reason, postedAt, entries, and previousHash.
-- idempotency_key and meta were stored on ledger_tx and left out of the digest.
-- verifyChain recomputed that same payload, so
--
--   UPDATE ledger_tx SET idempotency_key = 'something-else' WHERE id = ...
--
-- still verified. The unique index then no longer held the original key, and
-- a later post of that key missed the row and posted the movement again.
--
-- The shared hash contract stays unchanged. This trigger refuses rewrites;
-- 0017/0018 retain an append-only copy of the actual key, hash, and metadata.
-- Reconciliation and receipt reads compare that copy with the journal row.
-- Historical rows keep their stored digest and metadata; nothing is rehashed.

CREATE OR REPLACE FUNCTION "ledger"."ledger_tx_key_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.meta IS DISTINCT FROM OLD.meta THEN
    RAISE EXCEPTION 'ledger_tx idempotency_key and meta are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "ledger_tx_key_immutable" ON "ledger"."ledger_tx";
CREATE TRIGGER "ledger_tx_key_immutable"
  BEFORE UPDATE ON "ledger"."ledger_tx"
  FOR EACH ROW
  EXECUTE FUNCTION "ledger"."ledger_tx_key_immutable"();
