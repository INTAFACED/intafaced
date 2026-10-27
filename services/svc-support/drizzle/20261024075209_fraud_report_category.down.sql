-- Reverse 20261024075209_fraud_report_category.sql
-- intafaced:destructive narrows tickets_category_ck back to the categories without fraud_report
-- It fails while any fraud_report ticket exists, which is the point: a reversal must not drop or rewrite a report.

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_category_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_category_ck"
  CHECK ("category" IN ('account', 'trading', 'deposit_withdraw', 'phishing', 'other'));
