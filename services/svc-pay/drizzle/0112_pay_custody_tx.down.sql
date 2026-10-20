-- intafaced:destructive — reversal of 0112_pay_custody_tx.sql
--
-- Drops operator notes, lifecycle timeouts and confirmation overrides with their approvals. No balance lives in these
-- tables; this is for CI proof of reversibility and a database that recorded no real override.

DROP TRIGGER IF EXISTS "confirmation_override_approvals_append_only_trg" ON "pay"."confirmation_override_approvals";
DROP TRIGGER IF EXISTS "confirmation_override_requests_append_only_trg" ON "pay"."confirmation_override_requests";
DROP TRIGGER IF EXISTS "custody_lifecycle_timeout_append_only_trg" ON "pay"."custody_lifecycle_timeout_events";
DROP TRIGGER IF EXISTS "custody_tx_notes_append_only_trg" ON "pay"."custody_tx_notes";
DROP FUNCTION IF EXISTS "pay"."custody_tx_append_only"();
DROP TABLE IF EXISTS "pay"."confirmation_override_approvals";
DROP INDEX IF EXISTS "pay"."confirmation_override_withdrawal_idx";
DROP INDEX IF EXISTS "pay"."confirmation_override_network_idx";
DROP TABLE IF EXISTS "pay"."confirmation_override_requests";
DROP INDEX IF EXISTS "pay"."custody_lifecycle_timeout_state_idx";
DROP TABLE IF EXISTS "pay"."custody_lifecycle_timeout_events";
DROP INDEX IF EXISTS "pay"."custody_tx_notes_subject_idx";
DROP TABLE IF EXISTS "pay"."custody_tx_notes";
