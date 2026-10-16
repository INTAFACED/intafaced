-- intafaced:destructive — reversal of 0083_pay_dispute_deadlines_evidence.sql
--
-- Drops recorded rail due dates and stored evidence bytes. Metadata rows in
-- pay.merchant_dispute_evidence stay; they predate this migration.

DROP TRIGGER IF EXISTS "merchant_dispute_evidence_content_guard_trg" ON "pay"."merchant_dispute_evidence_content";
DROP TRIGGER IF EXISTS "dispute_response_deadlines_guard_trg" ON "pay"."dispute_response_deadlines";
DROP TABLE IF EXISTS "pay"."merchant_dispute_evidence_content";
DROP TABLE IF EXISTS "pay"."dispute_response_deadlines";
DROP FUNCTION IF EXISTS "pay"."merchant_dispute_evidence_content_guard"();
DROP FUNCTION IF EXISTS "pay"."dispute_response_deadline_guard"();
