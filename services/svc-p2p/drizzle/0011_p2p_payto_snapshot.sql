-- svc-p2p · freeze the pay-to account copied onto a trade.
-- Reversal: 0011_p2p_payto_snapshot.down.sql
--
-- NOT tagged `intafaced:destructive`: adds a trigger. Drops no table, column, or row.
--
-- 0001 documents trade_payment_instruments (lines 175–215) as the pay-to account
-- frozen when the trade opens, so a seller cannot swap destinations mid-trade.
-- The only constraint that file installs on the row is
-- trade_payment_instruments_purge_paired_ck, which pairs `details IS NULL` with
-- `purged_at`. While the row is unpurged, UPDATE details and fingerprint to a
-- different account commits. revealForTrade reads that row, so the buyer can be
-- shown a new account after they have started the transfer to the original one.
--
-- The purge transition stays legal: details cleared, purged_at set, fingerprint
-- unchanged. That is the statement purgeExpiredSnapshots and erasure already
-- write. The purge-paired check is not replaced.
--
-- WHY 0011 AND NOT AN EDIT TO 0001. scripts/migrate.ts records applied files by
-- name in p2p.__migrations. 0001 uses CREATE TABLE IF NOT EXISTS and would not
-- run again on a database that already applied it. The trigger would exist only
-- on databases created after the edit.

CREATE OR REPLACE FUNCTION "p2p"."trade_payment_instruments_destination_is_frozen"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'p2p: pay-to account frozen — snapshot cannot be deleted; purge its details' USING ERRCODE = 'check_violation';
  END IF;
  IF ROW(NEW."trade_id", NEW."instrument_id", NEW."owner_id", NEW."method_id", NEW."country", NEW."fiat_currency", NEW."label", NEW."fingerprint")
     IS DISTINCT FROM ROW(OLD."trade_id", OLD."instrument_id", OLD."owner_id", OLD."method_id", OLD."country", OLD."fiat_currency", OLD."label", OLD."fingerprint") THEN
    RAISE EXCEPTION 'p2p: pay-to account frozen — snapshot ownership and terms cannot change' USING ERRCODE = 'check_violation';
  END IF;
  -- Retention and erasure. Any other change to the account, including a purge
  -- that also rewrites the fingerprint, falls through and is refused.
  IF OLD."purged_at" IS NULL
     AND NEW."details" IS NULL
     AND NEW."purged_at" IS NOT NULL
     AND NEW."fingerprint" IS NOT DISTINCT FROM OLD."fingerprint" THEN
    RETURN NEW;
  END IF;

  IF NEW."details" IS DISTINCT FROM OLD."details"
     OR NEW."purged_at" IS DISTINCT FROM OLD."purged_at" THEN
    RAISE EXCEPTION
      'p2p: trade_payment_instruments is the pay-to account frozen when the trade opens — trade % cannot swap details or fingerprint',
      OLD."trade_id"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "trade_payment_instruments_destination_frozen_trg" ON "p2p"."trade_payment_instruments";
CREATE TRIGGER "trade_payment_instruments_destination_frozen_trg"
  BEFORE UPDATE OR DELETE ON "p2p"."trade_payment_instruments"
  FOR EACH ROW
  EXECUTE FUNCTION "p2p"."trade_payment_instruments_destination_is_frozen"();
