-- intafaced:destructive drops accounts_lock_purposed_ck, replaced in the same
-- migration by a fail-closed form of the same constraint.
-- svc-ledger · a purpose nobody can read is not a purpose (follow-on to 0007)
-- Reversal: 0008_purpose_fail_closed.down.sql
--
-- THE DEFECT, in two halves. 0007 closed STOP §4.2b #1 correctly — the CHECK it
-- added is the right constraint to want — but it got there two ways that undo it
-- on the first populated database it meets.
--
-- HALF ONE · the backfill minted a claim identity out of nothing.
--
--   UPDATE accounts SET purpose = 'legacy:' || id::text
--    WHERE kind IN ('escrow','stake','collateral') AND length(purpose) = 0;
--
-- A purpose names WHOSE reservation the pot holds — `loan:7c3f…`, `p2p:trade:…`.
-- It is read to decide whether releasing this pot is releasing the right value.
-- `legacy:<the row's own id>` names the row itself, which every row already
-- does, so it answers the question with the question.
--
-- The cost is not cosmetic. `accounts.ts` states the disaster in full: "releasing
-- loan A's collateral could hand back value that was securing loan B: both
-- postings balance, the journal reconciles, and loan B is quietly unsecured."
-- That is exactly the row the backfill creates — and after it runs, the CHECK
-- passes on it, and no query anywhere can separate a pot that was always
-- properly claimed from one nobody could attribute. The constraint added to
-- catch unattributable collateral now certifies it instead.
--
-- It went green because a clean tip has no such rows: the UPDATE touched
-- nothing. The behaviour only appears where it costs the most.
--
-- Repo precedent is unanimous the other way. 0005 STEP 3 and 0006 STEP 1 both
-- REFUSE and name every offending row rather than guess an identity, on the
-- stated grounds that guessing moves real value to a possibly-wrong owner. A
-- migration that stops a deploy on a database holding unattributable collateral
-- is the correct outcome, and this makes it the chosen one rather than an
-- accident of which fixture ran first.
--
-- HALF TWO · the CHECK enumerates the locked kinds, so it fails OPEN.
--
--   CHECK (kind NOT IN ('hold','escrow','stake','collateral') OR length(purpose) > 0)
--
-- Add a sixth `account_kind` — a lien, a margin pot, a bond — and it lands
-- outside the list, unconstrained, silently. The next agent to add a lock kind
-- has to know this line exists to keep the invariant. Only ONE kind is genuinely
-- unlocked (`available`, per ACCOUNT_KINDS in ledger-client), so naming that one
-- exemption inverts the failure: a new kind is covered from the moment it exists
-- and must opt out deliberately.

-- STEP 1 · REFUSE — every row here holds value under a claim nobody can read.
--
-- There is no honest automatic repair. The mapping from an unpurposed pot to the
-- loan, trade or stake it secures lives in whichever module reserved it, and
-- guessing wrong hands one user's collateral back against another user's debt.
-- Failing here fails at migrate time, naming every offending row, on the
-- populated database where the problem actually is — rather than succeeding on
-- an empty one and taking the platform down later, or worse, not at all.
--
-- Two shapes are refused: an empty purpose (which 0007 would have overwritten),
-- and a surviving `legacy:` stamp (which 0007 already wrote on a database that
-- ran it before this landed). The second is why this cannot be a plain CHECK —
-- those rows currently satisfy 0007's constraint.
DO $$
DECLARE
  offenders text;
  n bigint;
BEGIN
  SELECT count(*), string_agg(format('%s/%s %s %s purpose=%L balance=%s', "owner_type", "owner_id", "asset_id", "kind", "purpose", "balance"), E'\n  ')
    INTO n, offenders
    FROM "ledger"."accounts"
   WHERE "kind" <> 'available'
     AND (length("purpose") = 0 OR "purpose" LIKE 'legacy:%');

  IF n > 0 THEN
    RAISE EXCEPTION
      E'Cannot apply 0008: % lock account row(s) hold value under a purpose that names nothing.\n  %\n\n'
      'A purpose says whose reservation the pot holds; it is read to decide whether releasing '
      'this pot releases the right value. An empty one, or a "legacy:<row id>" one written by '
      '0007''s backfill, answers that question with nothing — and accounts.ts names the cost: '
      'releasing loan A''s collateral can hand back value securing loan B, while every posting '
      'balances and reconciliation stays green.\n\n'
      'This migration will not guess. For each row above, set "purpose" to the claim that '
      'actually reserved it (the module that created the pot knows: loan:<id>, p2p:trade:<id>, '
      'stake:<id>, …), then re-run. If a pot genuinely reserves nothing, it is not a lock pot — '
      'move its balance out and delete it. Precedent: 0005 STEP 3, 0006 STEP 1.',
      n, offenders;
  END IF;
END $$;

-- STEP 2 · Re-state the same invariant, fail-closed.
--
-- `available` is the only kind in ACCOUNT_KINDS that reserves nothing, so it is
-- the only exemption. Any kind added later is constrained the moment the enum
-- grows, with no second edit here required.
--
-- The `legacy:` clause makes STEP 1's ruling permanent rather than a one-time
-- sweep. Without it the stamp is refused for rows that already exist and
-- accepted for every row inserted afterwards — including by a future migration
-- that copies 0007's pattern, which is exactly how this arrived. The namespace
-- is now reserved and unusable, which is the honest status of a purpose that
-- names its own row.
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_hold_purposed_ck";
ALTER TABLE "ledger"."accounts" DROP CONSTRAINT IF EXISTS "accounts_lock_purposed_ck";
ALTER TABLE "ledger"."accounts" ADD CONSTRAINT "accounts_lock_purposed_ck"
  CHECK (
    "kind" = 'available'
    OR (length("purpose") > 0 AND "purpose" NOT LIKE 'legacy:%')
  );
