-- svc-support · emailed rating request outbox (SP-csat-01)
-- Reversal: 0021_rating_requests.down.sql
--
-- One row per ticket, written in the same transaction that first resolves it (the trigger
-- below), so a crash after the status commit cannot lose the ask. `published_at` stays null
-- until the event bus took `support.ticket.resolved`; a sweep publishes the rest. A ticket
-- that is reopened and resolved again keeps its one row: the customer is asked once.
-- Tickets resolved before this migration have no row and are never asked.

CREATE TABLE IF NOT EXISTS "support"."rating_requests" (
  "ticket_id" uuid PRIMARY KEY REFERENCES "support"."tickets" ("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "resolved_at" timestamptz NOT NULL,
  "published_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "rating_requests_pending_idx" ON "support"."rating_requests" ("resolved_at") WHERE "published_at" IS NULL;

CREATE OR REPLACE FUNCTION "support"."tickets_record_rating_request"() RETURNS trigger AS $$
BEGIN
  IF NEW."status" = 'resolved' AND OLD."status" IS DISTINCT FROM NEW."status" THEN
    INSERT INTO "support"."rating_requests" ("ticket_id", "user_id", "resolved_at")
    VALUES (NEW."id", NEW."user_id", NEW."updated_at")
    ON CONFLICT ("ticket_id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "tickets_record_rating_request" ON "support"."tickets";
CREATE TRIGGER "tickets_record_rating_request"
  AFTER UPDATE OF "status" ON "support"."tickets"
  FOR EACH ROW EXECUTE FUNCTION "support"."tickets_record_rating_request"();
