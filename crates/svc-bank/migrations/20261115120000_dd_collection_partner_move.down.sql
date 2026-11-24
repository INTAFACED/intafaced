-- Reverses 20261115120000_dd_collection_partner_move.sql. Refuses while any collection the partner made is recorded, so a
-- partner's reference is never dropped.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."dd_collections" WHERE "partner_move_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'dd_collections holds partner moves; refusing to drop partner_move_id';
  END IF;
END $$;
ALTER TABLE "bank"."dd_collections" DROP CONSTRAINT IF EXISTS "dd_collections_posted_ck";
ALTER TABLE "bank"."dd_collections" ADD CONSTRAINT "dd_collections_posted_ck" CHECK (("status" = 'collected') = ("ledger_tx_id" IS NOT NULL));
ALTER TABLE "bank"."dd_collections" DROP COLUMN IF EXISTS "partner_move_id";
