-- intafaced:destructive — reversal of 20261109021803_ticket_links.sql
DROP TRIGGER IF EXISTS "ticket_links_append_only" ON "support"."ticket_links";
DROP TABLE IF EXISTS "support"."ticket_links";
DROP FUNCTION IF EXISTS "support"."ticket_links_append_only"();
