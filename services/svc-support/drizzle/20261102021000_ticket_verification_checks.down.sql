-- Reverse 20261102021000_ticket_verification_checks.sql
-- intafaced:destructive the checks recorded on requests are dropped; the records they quoted stay with their owners.

DROP TRIGGER IF EXISTS "ticket_verification_checks_append_only_trg" ON "support"."ticket_verification_checks";
DROP FUNCTION IF EXISTS "support"."ticket_verification_checks_append_only"();
DROP TABLE IF EXISTS "support"."ticket_verification_checks";
