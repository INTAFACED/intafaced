-- svc-support · fraud reports go to the compliance group (SP-tickets-01, J-support-public-02 #4)
-- Reversal: 20261024075209_fraud_report_category.down.sql
--
-- NOT tagged `intafaced:destructive`: it widens tickets_category_ck under the same name. It drops no table, no column
-- and no row. A fraud report is grouped into the owner's named desk group when it is made; the group itself and its
-- name are not stored here.

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_category_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_category_ck"
  CHECK ("category" IN ('account', 'trading', 'deposit_withdraw', 'phishing', 'fraud_report', 'other'));
