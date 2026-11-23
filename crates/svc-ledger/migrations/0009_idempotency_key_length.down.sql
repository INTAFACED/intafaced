-- Reversal of 0009_idempotency_key_length.sql — drops the length CHECK.
--
-- STEP 1 raised rather than writing, so it has nothing to reverse: no key was
-- rewritten on the way in, so none has to be restored here.
--
-- Going back only widens what the table accepts, back to `text NOT NULL` plus the
-- UNIQUE index that 0000 created. No data is at risk in this direction — only the
-- invariant, which `assertValidPost` still enforces on the TypeScript path.
ALTER TABLE "ledger"."ledger_tx" DROP CONSTRAINT IF EXISTS "ledger_tx_idempotency_key_len_ck";
