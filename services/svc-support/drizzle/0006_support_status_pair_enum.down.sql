-- Reverse 0006_support_status_pair_enum.sql
-- Restores the 0001 status pair: non-null, different, any text.

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_status_pair_ck";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_status_pair_ck"
  CHECK (
    ("kind" <> 'status_changed' AND "from_status" IS NULL AND "to_status" IS NULL)
    OR ("kind" = 'status_changed' AND "from_status" IS NOT NULL AND "to_status" IS NOT NULL AND "from_status" <> "to_status")
  );
