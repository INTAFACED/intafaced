-- Reverse 0015_p2p_void_zero_lock_attempts.sql
--
-- Restores the 0014 function. Afterwards a void is refused unless
-- escrow_lock_attempts is exactly 1, including a created trade whose counter
-- is still 0 because no lock was claimed. The trigger and the column stay.

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
     AND OLD."escrow_lock_attempts" IS DISTINCT FROM 1::bigint THEN
    RAISE EXCEPTION 'p2p: unresolved escrow lock attempts cannot be voided'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
