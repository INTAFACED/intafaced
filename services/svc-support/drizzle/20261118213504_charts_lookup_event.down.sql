-- Reverses 20261118213504_charts_lookup_event.sql. The trail is append-only, so a database that already holds a
-- `charts_lookup` row refuses the reversal rather than rewrite history.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support"."ticket_events" WHERE "kind" = 'charts_lookup') THEN
    RAISE EXCEPTION '20261118213504 cannot be reversed while a charts_lookup trail row exists';
  END IF;
END $$;

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_kind_ck";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_kind_ck"
  CHECK ("kind" IN ('opened', 'assigned', 'status_changed', 'grounding_read', 'escalated', 'merged'));
