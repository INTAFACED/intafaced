ALTER TABLE "bank"."card_cashback" DROP CONSTRAINT IF EXISTS "card_cashback_settled_has_tx_ck";
ALTER TABLE "bank"."card_settlements" DROP CONSTRAINT IF EXISTS "card_settlements_settled_has_tx_ck";
ALTER TABLE "bank"."card_authorizations" DROP CONSTRAINT IF EXISTS "card_authorizations_settled_approved_has_hold_ck";
