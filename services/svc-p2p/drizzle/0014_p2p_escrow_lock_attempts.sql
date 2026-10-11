-- Record possible remote lock attempts, never money or a ledger receipt.
-- Existing rows retain NULL unknown history; no DEFAULT and no backfill.
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "escrow_lock_attempts" bigint;
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_lock_attempts_nonnegative_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_lock_attempts_nonnegative_ck" CHECK ("escrow_lock_attempts" >= 0);

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
DROP TRIGGER IF EXISTS "p2p_trades_lock_attempts_monotonic_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_lock_attempts_monotonic_trg" BEFORE INSERT OR UPDATE ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_lock_attempts_monotonic"();
