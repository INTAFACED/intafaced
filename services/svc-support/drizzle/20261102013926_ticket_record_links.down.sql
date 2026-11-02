-- Reverse 20261102013926_ticket_record_links.sql
-- intafaced:destructive the links between requests and their records are dropped; the records themselves stay with their owners.

DROP TRIGGER IF EXISTS "ticket_record_links_append_only_trg" ON "support"."ticket_record_links";
DROP FUNCTION IF EXISTS "support"."ticket_record_links_append_only"();
DROP TABLE IF EXISTS "support"."ticket_record_links";
