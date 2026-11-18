-- Reverses 20261116030000_business_bills.sql. Refuses, changing nothing, while any bill payment reached the partner:
-- dropping its row would erase the only record of which instruction the partner carried out for the business.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "bank"."business_bill_payments" WHERE "partner_move_id" IS NOT NULL OR "status" = 'sending') THEN
    RAISE EXCEPTION 'business_bills down: bill payments reached the partner; nothing was changed';
  END IF;
END
$$;

-- intafaced:destructive the bill, vendor, limit and bill payment tables this migration added, with no payment the partner carried out
DROP TABLE IF EXISTS "bank"."business_bill_splits";
DROP TABLE IF EXISTS "bank"."business_bill_payments";
DROP TABLE IF EXISTS "bank"."business_bill_limits";
DROP TABLE IF EXISTS "bank"."business_bill_vendors";
DROP TABLE IF EXISTS "bank"."business_bill_approvals";
DROP TABLE IF EXISTS "bank"."business_bills";
