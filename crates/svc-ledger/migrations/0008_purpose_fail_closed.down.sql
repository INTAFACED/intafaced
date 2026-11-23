-- Reversal of 0008_purpose_fail_closed.sql — restores 0007's enumerated CHECK.
--
-- STEP 1 raised rather than writing, so it has nothing to reverse: no purpose
-- was invented on the way in, which means none has to be un-invented here. That
-- is the whole practical argument for refusing over backfilling — a migration
-- that guesses an identity has no honest reversal at all.
--
-- Going back is therefore only a widening of what the database will accept, and
-- widens it exactly as far as 0007 had it. No data is at risk in this direction —
-- only the invariant.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_lock_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_lock_purposed_ck"
  CHECK (
    "kind" NOT IN ('hold', 'escrow', 'stake', 'collateral')
    OR length("purpose") > 0
  );
