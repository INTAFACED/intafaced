-- Reverse 20261109095745_scam_reports.sql
-- intafaced:destructive drops the scam case notes, and narrows tickets_category_ck and the safety case kind back. The narrowing fails while any scam
-- report exists, which is the point: a reversal must not drop or rewrite a request.

ALTER TABLE "support"."safety_cases" DROP CONSTRAINT IF EXISTS "safety_cases_case_note_scam";
ALTER TABLE "support"."safety_cases" DROP COLUMN IF EXISTS "case_note";

ALTER TABLE "support"."safety_cases" DROP CONSTRAINT IF EXISTS "safety_cases_kind_check";
ALTER TABLE "support"."safety_cases" ADD CONSTRAINT "safety_cases_kind_check"
  CHECK ("kind" IN ('complaint', 'bereavement'));

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_category_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_category_ck"
  CHECK ("category" IN ('account', 'trading', 'deposit_withdraw', 'phishing', 'fraud_report', 'other', 'complaint', 'bereavement'));
