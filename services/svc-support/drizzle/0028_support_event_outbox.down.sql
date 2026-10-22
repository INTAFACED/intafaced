-- Reverse 0028_support_event_outbox.sql
-- Lossy: the record of which request events were already published is dropped.
DROP TRIGGER IF EXISTS "comments_outbox_created" ON "support"."comments";
DROP FUNCTION IF EXISTS "support"."comments_outbox_created"();
DROP TRIGGER IF EXISTS "tickets_outbox_updated" ON "support"."tickets";
DROP FUNCTION IF EXISTS "support"."tickets_outbox_updated"();
DROP TRIGGER IF EXISTS "tickets_outbox_opened" ON "support"."tickets";
DROP FUNCTION IF EXISTS "support"."tickets_outbox_opened"();
DROP TABLE IF EXISTS "support"."event_outbox";
DROP SEQUENCE IF EXISTS "support"."event_outbox_seq";
