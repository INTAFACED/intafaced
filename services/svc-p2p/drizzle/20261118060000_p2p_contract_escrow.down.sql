-- Reverses 20261118060000_p2p_contract_escrow.sql. Refuses while any contract-escrow order exists: dropping its columns
-- would lose which deal holds its coins.
-- The runner applies every down in reverse on each `--down`, so this file is a no-op once its columns are gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'p2p' AND table_name = 'p2p_trades' AND column_name = 'escrow_kind') THEN
    IF EXISTS (SELECT 1 FROM "p2p"."p2p_trades" WHERE "escrow_kind" = 'contract') THEN
      RAISE EXCEPTION 'p2p: contract-escrow orders exist; their deal records cannot be dropped';
    END IF;
  END IF;
END;
$$;
-- 0014's lock-attempt rule as it was, while 0014's column still stands.
DO $outer$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'p2p' AND table_name = 'p2p_trades' AND column_name = 'escrow_lock_attempts') THEN
    EXECUTE $ddl$
CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_lock_attempts_monotonic"() RETURNS trigger
LANGUAGE plpgsql AS $fn$
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
END $fn$;
$ddl$;
  END IF;
END;
$outer$;
DROP TRIGGER IF EXISTS "p2p_trades_contract_escrow_fixed_trg" ON "p2p"."p2p_trades";
DROP FUNCTION IF EXISTS "p2p"."p2p_trades_contract_escrow_fixed"();
DROP INDEX IF EXISTS "p2p"."p2p_trades_contract_deal_uq";
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_contract_deal_ck";
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_contract_no_ledger_ck";
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_contract_terms_ck";
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_escrow_kind_ck";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "contract_seller_wallet";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "contract_deal_id";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "contract_dispute_window_seconds";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "contract_buyer_wallet";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "contract_units";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "contract_token";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "contract_chain_id";
ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "escrow_kind";
