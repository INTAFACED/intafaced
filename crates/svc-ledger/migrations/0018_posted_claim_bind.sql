-- svc-ledger · the posted claim remembers the hash and meta
-- Reversal: 0018_posted_claim_bind.down.sql
--
-- 0016 refuses UPDATE of ledger_tx.idempotency_key and meta. 0017 keeps the
-- original key claimed after that trigger is disabled. verifyChain still
-- accepts the legacy short digest (the hash of a row whose key was not
-- covered) for every row. A role that disables only ledger_tx_key_immutable
-- can retarget the key, write that short digest into ledger_tx.hash, and the
-- chain stays green. The same rewrite works for meta. A historical row whose
-- stored hash never covered the key stays green after the key alone changes,
-- because the short digest does not change.
--
-- posted_hash and posted_meta are the hash and meta stored at insert. They
-- are not balances. The backfill copies ledger_tx.hash and ledger_tx.meta; it
-- does not rehash. The append-only trigger blocks that UPDATE, so it is
-- dropped around the copy and installed again afterwards. UPDATE and DELETE
-- of these columns are refused with the rest of the row.

ALTER TABLE "ledger"."ledger_posted_keys"
  ADD COLUMN IF NOT EXISTS "posted_hash" text,
  ADD COLUMN IF NOT EXISTS "posted_meta" jsonb;

DROP TRIGGER IF EXISTS "ledger_posted_keys_immutable" ON "ledger"."ledger_posted_keys";

UPDATE "ledger"."ledger_posted_keys" AS k
   SET "posted_hash" = t."hash",
       "posted_meta" = t."meta"
  FROM "ledger"."ledger_tx" AS t
 WHERE k."tx_id" = t."id"
   AND (k."posted_hash" IS NULL OR k."posted_meta" IS NULL);

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n
    FROM "ledger"."ledger_posted_keys"
   WHERE "posted_hash" IS NULL OR "posted_meta" IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION
      'Cannot apply 0018: % posted-key claim(s) have no journal hash and meta to copy',
      n;
  END IF;
END $$;

ALTER TABLE "ledger"."ledger_posted_keys" ALTER COLUMN "posted_hash" SET NOT NULL;
ALTER TABLE "ledger"."ledger_posted_keys" ALTER COLUMN "posted_meta" SET NOT NULL;

CREATE OR REPLACE FUNCTION "ledger"."ledger_posted_keys_immutable"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ledger_posted_keys is append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "ledger_posted_keys_immutable"
  BEFORE UPDATE OR DELETE ON "ledger"."ledger_posted_keys"
  FOR EACH ROW
  EXECUTE FUNCTION "ledger"."ledger_posted_keys_immutable"();
