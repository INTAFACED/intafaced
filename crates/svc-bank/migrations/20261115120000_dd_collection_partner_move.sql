-- A direct debit collection the partner bank made (J-bank-06 #4; OWNER 226: INTAFACED holds no customer money). When the
-- partner holds the person's main balance, a collection is ONE partner move under the business key
-- `bank.dd.collection:<mandate>:<collection>`, and the row records the partner's own reference for it. Nothing is posted
-- to the ledger for it, so `ledger_tx_id` stays NULL.
--
-- One collection is ONE movement: a collected row names exactly one of the ledger transaction and the partner move, and
-- every other row names neither. Every row the old rule allowed, this one allows.
--
-- Reversal: 20261115120000_dd_collection_partner_move.down.sql

ALTER TABLE "bank"."dd_collections" ADD COLUMN IF NOT EXISTS "partner_move_id" text;

ALTER TABLE "bank"."dd_collections" DROP CONSTRAINT IF EXISTS "dd_collections_posted_ck";
ALTER TABLE "bank"."dd_collections" ADD CONSTRAINT "dd_collections_posted_ck"
  CHECK (
    CASE WHEN "status" = 'collected'
      THEN ("ledger_tx_id" IS NOT NULL) <> ("partner_move_id" IS NOT NULL)
      ELSE "ledger_tx_id" IS NULL AND "partner_move_id" IS NULL
    END
  );
