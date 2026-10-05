-- svc-p2p · freeze seller_id and buyer_id after insert.
-- Reversal: 0010_p2p_party_snapshot.down.sql
--
-- NOT tagged `intafaced:destructive`: adds a trigger. Drops no table, column, or row.
--
-- 0000 comments seller_id / buyer_id as a snapshot taken at take, so a later
-- edit cannot re-point an open escrow. The only party constraint that file
-- installs is seller_id <> buyer_id. settleOnce posts escrowRelease and
-- escrowRefund against those two columns, so an UPDATE after insert sends the
-- escrow to someone else.
--
-- A new file, not an edit of 0000. scripts/migrate.ts records applied files by
-- name in p2p.__migrations, so rewriting 0000 would not run again where it
-- has already been applied.

CREATE OR REPLACE FUNCTION "p2p"."p2p_trades_parties_are_snapshotted"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."seller_id" IS DISTINCT FROM OLD."seller_id"
     OR NEW."buyer_id" IS DISTINCT FROM OLD."buyer_id" THEN
    RAISE EXCEPTION
      'p2p: seller_id and buyer_id are snapshotted at take and cannot be re-pointed — trade %', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "p2p_trades_parties_are_snapshotted_trg" ON "p2p"."p2p_trades";
CREATE TRIGGER "p2p_trades_parties_are_snapshotted_trg"
  BEFORE UPDATE ON "p2p"."p2p_trades"
  FOR EACH ROW EXECUTE FUNCTION "p2p"."p2p_trades_parties_are_snapshotted"();
