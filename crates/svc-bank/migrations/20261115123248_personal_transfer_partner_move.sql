-- A send to another person whose money the partner bank holds (J-bank-04 #4; OWNER 226, CUSTODY-DELTA): the partner moves
-- it once, from the sender's account at the partner to the recipient's, under the send's business key, and the ledger posts
-- nothing. The posted row then names the partner's move instead of a ledger transaction. A posted row names exactly one of
-- the two; a reserved row names neither.
--
-- Reversal: 20261115123248_personal_transfer_partner_move.down.sql

ALTER TABLE "bank"."personal_transfers" ADD COLUMN IF NOT EXISTS "partner_move_id" text;

ALTER TABLE "bank"."personal_transfers" DROP CONSTRAINT IF EXISTS "personal_transfers_partner_move_uq";
ALTER TABLE "bank"."personal_transfers" ADD CONSTRAINT "personal_transfers_partner_move_uq" UNIQUE ("partner_move_id");

ALTER TABLE "bank"."personal_transfers" DROP CONSTRAINT IF EXISTS "personal_transfers_posted_tx_ck";
ALTER TABLE "bank"."personal_transfers" ADD CONSTRAINT "personal_transfers_posted_tx_ck" CHECK (
  ("status" = 'posted' AND (("ledger_tx_id" IS NOT NULL) <> ("partner_move_id" IS NOT NULL)))
  OR ("status" = 'reserved' AND "ledger_tx_id" IS NULL AND "partner_move_id" IS NULL)
);
