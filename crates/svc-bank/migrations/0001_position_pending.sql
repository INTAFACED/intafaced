-- L3-3: pending earn position claim before ledger post (no interest until active).
DO $$ BEGIN
  ALTER TYPE "bank"."position_status" ADD VALUE 'pending' BEFORE 'active';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
