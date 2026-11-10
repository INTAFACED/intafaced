-- svc-support · a scam report with its amount and transfer, acknowledged once (BK-safe-02, J-bank-18 #3)
-- Reversal: 20261109095745_scam_reports.down.sql
--
-- NOT tagged `intafaced:destructive`: it widens tickets_category_ck and the safety case kind under their names with
-- `scam`, and adds one nullable column. It drops no table, no column and no row.
--
-- case_note: a scam report's case note, written once when it is acknowledged (the amount, the transfer the bank confirmed
-- the person sent, when and how they were contacted). Only a scam report has one.

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_category_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_category_ck"
  CHECK ("category" IN ('account', 'trading', 'deposit_withdraw', 'phishing', 'fraud_report', 'other', 'complaint', 'bereavement', 'scam'));

ALTER TABLE "support"."safety_cases" DROP CONSTRAINT IF EXISTS "safety_cases_kind_check";
ALTER TABLE "support"."safety_cases" ADD CONSTRAINT "safety_cases_kind_check"
  CHECK ("kind" IN ('complaint', 'bereavement', 'scam'));

ALTER TABLE "support"."safety_cases" ADD COLUMN IF NOT EXISTS "case_note" text;
ALTER TABLE "support"."safety_cases" DROP CONSTRAINT IF EXISTS "safety_cases_case_note_scam";
ALTER TABLE "support"."safety_cases" ADD CONSTRAINT "safety_cases_case_note_scam"
  CHECK (("kind" = 'scam') = ("case_note" IS NOT NULL));
