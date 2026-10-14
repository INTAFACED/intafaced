-- svc-p2p · a trade that never locked can be voided.
-- Reversal: 0015_p2p_void_zero_lock_attempts.down.sql
--
-- NOT tagged `intafaced:destructive`: replaces a trigger function. No table,
-- column, or row changes, and no UPDATE. `0011`'s
-- `p2p_trades_voided_requires_no_escrow_ck` stays.
--
-- WHAT WAS WRONG
--
-- `0014` allows a void only when `escrow_lock_attempts` is exactly 1. Insert
-- stamps 0, which means no lock was claimed. That 0 is not an unresolved
-- attempt, and a created trade with no escrow stamp and no frozen escrow
-- figure has to be voidable. NULL stays unknown history. Any count other than
-- 0 or 1 may still be in flight and stays refused.
--
-- A row that already holds escrow is not "no lock", whatever the counter
-- says. The trigger still refuses that void. The check from `0011` remains
-- the same predicate on the row that would be written.

CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_lock_attempts_monotonic"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."escrow_lock_attempts" := 0;
    RETURN NEW;
  END IF;
  IF NEW."escrow_lock_attempts" IS DISTINCT FROM OLD."escrow_lock_attempts" THEN
    IF OLD."escrow_lock_attempts" IS NULL OR NEW."escrow_lock_attempts" IS NULL
       OR NEW."escrow_lock_attempts" <> OLD."escrow_lock_attempts" + 1
       OR OLD."status" <> 'created' OR NEW."status" <> 'created' THEN
      RAISE EXCEPTION 'p2p: escrow lock attempt history cannot reset, decrease, jump or fabricate unknown history'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD."resolution" IS NULL AND NEW."resolution" = 'voided'
     AND (
       OLD."escrowed_at" IS NOT NULL
       OR OLD."escrow_amount" IS NOT NULL
       OR (
         OLD."escrow_lock_attempts" IS DISTINCT FROM 0::bigint
         AND OLD."escrow_lock_attempts" IS DISTINCT FROM 1::bigint
       )
     ) THEN
    RAISE EXCEPTION 'p2p: unresolved escrow lock attempts cannot be voided'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
