-- intafaced:destructive — reversal of 0002_durable_freeze.sql
--
-- Dropping this table hands the freeze back to process memory, which means the
-- next restart resumes posting. If the ledger is frozen RIGHT NOW, that is not
-- a rollback — it is an unfreeze performed by a schema change, with no operator
-- and no record, against a book somebody deliberately halted.
--
-- So this refuses instead of guessing, the same way 0001's reversal refuses to
-- merge two purposed holds. Thaw it deliberately first (`unfreeze`, which names
-- an actor and emits `intafaced.ledger.freeze.updated`) and then roll back.
--
-- The check and the drop are one statement. SHARE ROW EXCLUSIVE is taken before
-- the read and held until the statement ends, so a freeze cannot commit after
-- the read and before the drop. Selecting only the frozen row locks nothing
-- while the seeded row is still thawed. A DROP that follows in a later
-- statement would release that lock on autocommit, which is the same gap.
DO $$
DECLARE
  is_frozen boolean;
  frozen_reason text;
  recorded_actor text;
BEGIN
  LOCK TABLE "ledger"."posting_freeze" IN SHARE ROW EXCLUSIVE MODE;

  SELECT "frozen", "reason", "actor" INTO is_frozen, frozen_reason, recorded_actor
    FROM "ledger"."posting_freeze"
   WHERE "id" = true
   FOR UPDATE;

  IF recorded_actor IS NOT NULL AND NOT is_frozen THEN
    RAISE EXCEPTION 'Cannot reverse 0002: recorded switch attribution must be preserved';
  END IF;

  IF is_frozen THEN
    RAISE EXCEPTION
      'Cannot reverse 0002: ledger posting is frozen (%). Dropping posting_freeze would resume posting on the '
      'next restart with nobody having decided to. Unfreeze deliberately first, then roll back.',
      coalesce(frozen_reason, 'no reason recorded');
  END IF;

  DROP TABLE "ledger"."posting_freeze";
END $$;
