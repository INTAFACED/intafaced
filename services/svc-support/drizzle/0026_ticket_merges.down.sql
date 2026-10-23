-- Reverse 0026_ticket_merges.sql
-- Lossy: the merged-into links are dropped. A merge cannot be undone and the trail is append-only, so a database that already
-- holds a merge or a `merged` trail row refuses the reversal rather than rewrite history.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support"."ticket_merges")
     OR EXISTS (SELECT 1 FROM "support"."ticket_events" WHERE "kind" = 'merged') THEN
    RAISE EXCEPTION '0026 cannot be reversed while a merge or a merged trail row exists';
  END IF;
END $$;

DROP TABLE IF EXISTS "support"."ticket_merges";

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_kind_ck";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_kind_ck"
  CHECK ("kind" IN ('opened', 'assigned', 'status_changed', 'grounding_read', 'escalated'));
