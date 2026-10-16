-- intafaced:destructive — reversal of 0083_pay_dispute_deadlines_evidence.sql
--
-- Drops durable dispute cases, recorded rail due dates, and stored evidence
-- bytes. Metadata rows in pay.merchant_dispute_evidence stay; they predate
-- this migration. There is no case backfill to undo.

DROP TRIGGER IF EXISTS "dispute_case_rail_events_append_only_trg" ON "pay"."dispute_case_rail_events";
DROP TRIGGER IF EXISTS "dispute_cases_guard_trg" ON "pay"."dispute_cases";
DROP TABLE IF EXISTS "pay"."dispute_case_rail_events";
DROP TABLE IF EXISTS "pay"."dispute_cases";
DROP FUNCTION IF EXISTS "pay"."dispute_case_rail_events_append_only"();
DROP FUNCTION IF EXISTS "pay"."dispute_cases_guard"();

DROP TRIGGER IF EXISTS "merchant_dispute_evidence_content_guard_trg" ON "pay"."merchant_dispute_evidence_content";
DROP TRIGGER IF EXISTS "dispute_response_deadlines_guard_trg" ON "pay"."dispute_response_deadlines";
DROP TABLE IF EXISTS "pay"."merchant_dispute_evidence_content";
DROP TABLE IF EXISTS "pay"."dispute_response_deadlines";
DROP FUNCTION IF EXISTS "pay"."merchant_dispute_evidence_content_guard"();
DROP FUNCTION IF EXISTS "pay"."dispute_response_deadline_guard"();
