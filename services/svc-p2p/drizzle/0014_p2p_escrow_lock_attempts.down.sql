-- intafaced:destructive — remove attempt-history protection only when no claimed created intent is unresolved.
-- Caller must execute the complete down and migration tracking update in one transaction.
-- PostgreSQL requires this lock in a transaction; retain it through guard and DDL.
LOCK TABLE "p2p"."p2p_trades" IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "p2p"."p2p_trades" WHERE "status" = 'created'
             AND "original_terms_claimed_at" IS NOT NULL AND "settled_at" IS NULL
             AND ("escrow_lock_attempts" IS NULL OR "escrow_lock_attempts" > 0)) THEN
    RAISE EXCEPTION 'p2p: refusing to remove unresolved escrow lock attempt history' USING ERRCODE = 'check_violation';
  END IF;
END $$;
DROP TRIGGER IF EXISTS "p2p_trades_lock_attempts_monotonic_trg" ON "p2p"."p2p_trades";
DROP FUNCTION IF EXISTS "p2p"."p2p_trades_lock_attempts_monotonic"();
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_lock_attempts_nonnegative_ck";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "escrow_lock_attempts";
