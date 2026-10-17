-- Reverse 0015. Restores the 0010 terms freeze (no terms_snapshot) and drops
-- the customer-depth tables. Open orders keep their amount/price/method freeze.
DROP INDEX IF EXISTS "p2p"."contacts_peer_block_idx";
DROP TABLE IF EXISTS "p2p"."contacts";
DROP TABLE IF EXISTS "p2p"."chat_reads";
DROP INDEX IF EXISTS "p2p"."chat_messages_trade_idx";
DROP TABLE IF EXISTS "p2p"."chat_messages";
DROP TABLE IF EXISTS "p2p"."write_keys";

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

ALTER TABLE "p2p"."p2p_trades" DROP COLUMN IF EXISTS "terms_snapshot";
