-- svc-ledger · the idempotency key must be a key, in the database too
-- Reversal: 0009_idempotency_key_length.down.sql
--
-- THE DEFECT
--
-- `assertValidPost` has required an idempotency key of at least 8 characters
-- since 0000. The column is `text NOT NULL` with a UNIQUE index and no length
-- constraint, so `''` and `'x'` are both insertable by raw SQL.
--
-- This is the #1044 / #1050 shape on the one column the whole no-double-spend
-- property rests on: an invariant asserted in TypeScript, on a table the README
-- says other insert paths will exist for. #1044's own words apply unchanged —
-- "TS is not the only insert path the README says will exist."
--
-- WHY A WEAK KEY IS A MONEY BUG, not untidiness.
--
-- The key IS the identity of a movement. `post()` returns the existing
-- transaction for a key it has already seen — and after #1060 it does so BEFORE
-- validating the body, which is the correct order and makes the key the only
-- thing standing between two different movements.
--
-- So a row inserted with `idempotency_key = ''` claims the empty key. The next
-- caller that reaches `post()` with a body whose key normalises to empty — an
-- adapter with a missing field, a migration backfill, a bug that passes `''` —
-- receives **that first transaction**, and is told its own money movement
-- succeeded. Nothing moved. No error is raised anywhere: from the ledger's point
-- of view a retry was correctly deduplicated.
--
-- Eight characters does not make a key unguessable; it makes it unlikely to be a
-- placeholder. That is what the rule was always for, and the database now holds
-- it.
--
-- STEP 1 · REFUSE. There is no honest repair for a short key already in the
-- journal: a posted transaction cannot be re-keyed (the key is what callers
-- deduplicate against, and the hash chain covers the row), and it cannot be
-- deleted (it is money that moved). So this names the rows and stops, exactly as
-- 0005 STEP 3, 0006 STEP 1 and 0008 STEP 1 do.
--
-- On a clean tip this touches nothing: every key the service has ever written
-- passed `assertValidPost` first.
DO $$
DECLARE
  offenders text;
  n bigint;
BEGIN
  SELECT count(*), string_agg(format('%s posted_at=%s module=%s key=%L', "id", "posted_at", "module", "idempotency_key"), E'\n  ')
    INTO n, offenders
    FROM "ledger"."ledger_tx"
   WHERE length("idempotency_key") < 8;

  IF n > 0 THEN
    RAISE EXCEPTION
      E'Cannot apply 0009: % journal row(s) were posted with an idempotency key shorter than the 8 characters '
      'assertValidPost requires.\n  %\n\n'
      'The key is the identity of a money movement: post() returns the existing transaction for a key it has '
      'already seen, so a placeholder key means the next caller to send the same placeholder is told ITS '
      'movement succeeded while nothing moved. These rows cannot be repaired automatically — a posted '
      'transaction cannot be re-keyed (callers deduplicate against the key, and the hash chain covers the row) '
      'and cannot be deleted (it is money that moved).\n\n'
      'A human has to decide per row whether the movement was real and what wrote it. Precedent: 0005 STEP 3, '
      '0006 STEP 1, 0008 STEP 1.',
      n, offenders;
  END IF;
END $$;

-- STEP 2 · The rule, in the database.
--
-- `>= 8` and not a pattern: `assertValidPost` constrains length only, and a
-- constraint that refuses more than the TypeScript path does would make the two
-- disagree in the other direction — which is the divergence #1060 was about.
ALTER TABLE "ledger"."ledger_tx" DROP CONSTRAINT IF EXISTS "ledger_tx_idempotency_key_len_ck";
ALTER TABLE "ledger"."ledger_tx" ADD CONSTRAINT "ledger_tx_idempotency_key_len_ck"
  CHECK (length("idempotency_key") >= 8);
