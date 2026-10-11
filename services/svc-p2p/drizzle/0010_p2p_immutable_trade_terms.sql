-- Claims complete original trade terms on NEW INSERT, before any ledger post.
-- Legacy rows remain NULL: their current mutable amount is not original proof.
-- No balance or receipt is stored; the timestamp attests only the initial terms.
ALTER TABLE "p2p"."p2p_trades" ADD COLUMN IF NOT EXISTS "original_terms_claimed_at" timestamptz;

CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_original_terms_frozen"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'p2p: immutable original terms cannot be deleted — trade %', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."original_terms_claimed_at" := clock_timestamp();
    RETURN NEW;
  END IF;
  IF ROW(NEW."id", NEW."offer_id", NEW."maker_id", NEW."taker_id", NEW."seller_id", NEW."buyer_id",
         NEW."asset", NEW."fiat_currency", NEW."amount", NEW."price", NEW."fiat_amount", NEW."method", NEW."fee_bps",
         NEW."original_terms_claimed_at")
     IS DISTINCT FROM
     ROW(OLD."id", OLD."offer_id", OLD."maker_id", OLD."taker_id", OLD."seller_id", OLD."buyer_id",
         OLD."asset", OLD."fiat_currency", OLD."amount", OLD."price", OLD."fiat_amount", OLD."method", OLD."fee_bps",
         OLD."original_terms_claimed_at") THEN
    RAISE EXCEPTION 'p2p: immutable original terms cannot change or be claimed after insert — trade %', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."escrowed_at" IS NOT NULL AND NEW."escrowed_at" IS DISTINCT FROM OLD."escrowed_at" THEN
    RAISE EXCEPTION 'p2p: escrow stamp cannot change or be cleared — trade %', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."resolution" IS NOT NULL AND ROW(NEW."status", NEW."resolution", NEW."resolution_reason", NEW."resolved_at")
     IS DISTINCT FROM ROW(OLD."status", OLD."resolution", OLD."resolution_reason", OLD."resolved_at") THEN
    RAISE EXCEPTION 'p2p: terminal decision and original recipe reason cannot change — trade %', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."settled_at" IS NOT NULL AND NEW."settled_at" IS DISTINCT FROM OLD."settled_at" THEN
    RAISE EXCEPTION 'p2p: settlement stamp cannot change or be cleared — trade %', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS "p2p_trades_original_terms_frozen_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_original_terms_frozen_trg" BEFORE INSERT OR UPDATE OR DELETE ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_original_terms_frozen"();

-- A claim is not a lock acknowledgement. Voids require that no lock was stamped.
-- Refuse incompatible populated rows; never rewrite their decisions or amounts.
ALTER TABLE "p2p"."p2p_trades" DROP CONSTRAINT IF EXISTS "p2p_trades_voided_requires_no_escrow_ck";
ALTER TABLE "p2p"."p2p_trades" ADD CONSTRAINT "p2p_trades_voided_requires_no_escrow_ck"
  CHECK ("resolution" IS DISTINCT FROM 'voided' OR "escrowed_at" IS NULL);
