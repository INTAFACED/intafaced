-- A settled card movement names the ledger transaction that moved the value.
--
-- 0003 only forces a decline to omit hold_ledger_tx_id. An approved
-- authorisation can be settled with that column null, and card_settlements
-- and card_cashback can be settled with ledger_tx_id null. A decline may
-- still omit a transaction: this check demands a hold only when the decision
-- is approved and the row is settled.
--
-- The check validates every existing row. A row that already violates fails
-- the migration. Nothing in this file rewrites a row.

ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_settled_approved_has_hold_ck";
ALTER TABLE "bank"."card_authorizations" ADD CONSTRAINT "card_authorizations_settled_approved_has_hold_ck"
  CHECK (
    "status" <> 'settled'
    OR "decision" <> 'approved'
    OR "hold_ledger_tx_id" IS NOT NULL
  );

ALTER TABLE "bank"."card_settlements" DROP CONSTRAINT IF EXISTS "card_settlements_settled_has_tx_ck";
ALTER TABLE "bank"."card_settlements" ADD CONSTRAINT "card_settlements_settled_has_tx_ck"
  CHECK ("status" <> 'settled' OR "ledger_tx_id" IS NOT NULL);

ALTER TABLE "bank"."card_cashback" DROP CONSTRAINT IF EXISTS "card_cashback_settled_has_tx_ck";
ALTER TABLE "bank"."card_cashback" ADD CONSTRAINT "card_cashback_settled_has_tx_ck"
  CHECK ("status" <> 'settled' OR "ledger_tx_id" IS NOT NULL);
