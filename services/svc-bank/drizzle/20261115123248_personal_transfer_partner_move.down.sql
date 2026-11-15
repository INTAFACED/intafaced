-- Refuses, changing nothing, while any send was moved by the partner: such a row names no ledger transaction, so the old
-- check re-added below could not hold it, and dropping the column would erase what the partner did.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."personal_transfers" WHERE "partner_move_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'personal_transfer_partner_move down: partner-moved sends exist; nothing was changed';
  END IF;
END
$$;

ALTER TABLE "bank"."personal_transfers" DROP CONSTRAINT IF EXISTS "personal_transfers_posted_tx_ck";
ALTER TABLE "bank"."personal_transfers" ADD CONSTRAINT "personal_transfers_posted_tx_ck" CHECK (
  ("status" = 'posted' AND "ledger_tx_id" IS NOT NULL) OR ("status" = 'reserved' AND "ledger_tx_id" IS NULL)
);
ALTER TABLE "bank"."personal_transfers" DROP CONSTRAINT IF EXISTS "personal_transfers_partner_move_uq";
ALTER TABLE "bank"."personal_transfers" DROP COLUMN IF EXISTS "partner_move_id";
