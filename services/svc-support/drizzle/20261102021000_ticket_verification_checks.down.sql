-- Reverse 20261102021000_ticket_verification_checks.sql
-- intafaced:destructive the checks recorded on requests and their audit are dropped; no value was ever stored in them.

DROP TRIGGER IF EXISTS "verification_audit_append_only_trg" ON "support"."verification_audit";
DROP TRIGGER IF EXISTS "ticket_verification_checks_append_only_trg" ON "support"."ticket_verification_checks";
DROP TABLE IF EXISTS "support"."verification_audit";
DROP TABLE IF EXISTS "support"."ticket_verification_checks";
DROP FUNCTION IF EXISTS "support"."ticket_verification_append_only"();
