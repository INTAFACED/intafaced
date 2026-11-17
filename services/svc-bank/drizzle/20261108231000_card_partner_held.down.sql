-- Refuses, changing nothing, while any partner-held row exists: those rows name a partner's reference and no ledger
-- transaction, so the old checks re-added below could not hold them, and dropping their columns would erase what the
-- partner did. Undo them at the partner first; this down is for a schema that never recorded one.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."card_authorizations" WHERE "money_book" = 'partner')
     OR EXISTS (SELECT 1 FROM "bank"."card_settlements" WHERE "money_book" = 'partner')
     OR EXISTS (SELECT 1 FROM "bank"."card_partner_refunds") THEN
    RAISE EXCEPTION 'card_partner_held down: partner-held card rows exist; nothing was changed';
  END IF;
END
$$;

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
