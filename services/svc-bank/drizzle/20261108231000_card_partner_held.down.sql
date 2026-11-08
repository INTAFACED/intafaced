DROP TABLE IF EXISTS "bank"."card_partner_refunds";

ALTER TABLE "bank"."card_settlements" DROP CONSTRAINT IF EXISTS "card_settlements_settled_has_tx_ck";
ALTER TABLE "bank"."card_settlements" DROP CONSTRAINT IF EXISTS "card_settlements_one_book";
ALTER TABLE "bank"."card_settlements" DROP CONSTRAINT IF EXISTS "card_settlements_money_book_known";
ALTER TABLE "bank"."card_settlements" DROP COLUMN IF EXISTS "partner_ref";
ALTER TABLE "bank"."card_settlements" DROP COLUMN IF EXISTS "money_book";
ALTER TABLE "bank"."card_settlements" ADD CONSTRAINT "card_settlements_settled_has_tx_ck"
  CHECK ("status" <> 'settled' OR "ledger_tx_id" IS NOT NULL);

ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_settled_approved_has_hold_ck";
ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_partner_mode_known";
ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_one_book";
ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_money_book_known";
ALTER TABLE "bank"."card_authorizations" DROP COLUMN IF EXISTS "partner_mode";
ALTER TABLE "bank"."card_authorizations" DROP COLUMN IF EXISTS "partner_hold_ref";
ALTER TABLE "bank"."card_authorizations" DROP COLUMN IF EXISTS "money_book";
ALTER TABLE "bank"."card_authorizations" ADD CONSTRAINT "card_authorizations_settled_approved_has_hold_ck"
  CHECK ("status" <> 'settled' OR "decision" <> 'approved' OR "hold_ledger_tx_id" IS NOT NULL);
