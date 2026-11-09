-- Reverse 20261107082443_safety_cases.sql
-- intafaced:destructive drops the complaint and bereavement acknowledgements, and narrows tickets_category_ck back.
-- The narrowing fails while any complaint or bereavement request exists, which is the point: a reversal must not drop or
-- rewrite a request.

DROP TRIGGER IF EXISTS "safety_cases_append_only_trg" ON "support"."safety_cases";
DROP TABLE IF EXISTS "support"."safety_cases";
DROP FUNCTION IF EXISTS "support"."safety_cases_append_only"();

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_category_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_category_ck"
  CHECK ("category" IN ('account', 'trading', 'deposit_withdraw', 'phishing', 'fraud_report', 'other'));
