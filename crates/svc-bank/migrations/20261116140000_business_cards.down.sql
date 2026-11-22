-- Reverses 20261116140000_business_cards.sql. Refuses, changing nothing, while any card purchase was captured or any
-- reimbursement reached the partner: dropping its row would erase the only record of a move the partner carried out.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."business_card_purchases" WHERE "partner_move_id" IS NOT NULL OR "status" = 'capturing')
     OR EXISTS (SELECT 1 FROM "bank"."business_reimbursements" WHERE "partner_move_id" IS NOT NULL OR "status" = 'paying') THEN
    RAISE EXCEPTION 'business_cards down: a card purchase or a reimbursement reached the partner; nothing was changed';
  END IF;
END
$$;

-- intafaced:destructive the business card and expense tables this migration added, with nothing the partner carried out
DROP TABLE IF EXISTS "bank"."business_reimbursements";
DROP TABLE IF EXISTS "bank"."business_receipt_reminders";
DROP TABLE IF EXISTS "bank"."business_purchase_receipts";
DROP TABLE IF EXISTS "bank"."business_receipts";
DROP TABLE IF EXISTS "bank"."business_expense_policies";
DROP TABLE IF EXISTS "bank"."business_card_limit_requests";
DROP TABLE IF EXISTS "bank"."business_card_purchases";
DROP TABLE IF EXISTS "bank"."business_cards";
