-- svc-support · request notification outbox (SP-email-01)
-- Reversal: 0028_support_event_outbox.down.sql
--
-- One row per request event, written by triggers in the same transaction as the
-- ticket or message row, so a crash after the commit cannot lose the event.
-- `event_key` is the business key and the bus idempotency key: a replay or a
-- second replica publishes the same message. `published_at` stays null until the
-- event bus took the event; a sweep publishes the rest. No text is copied here:
-- no subject, body, note or message text.
-- Requests and messages written before this migration have no row and are never announced.
-- ON DELETE CASCADE: deleting a ticket drops its unpublished events too (nothing left to announce).

CREATE TABLE IF NOT EXISTS "support"."event_outbox" (
  "event_key"    text PRIMARY KEY,
  "event_name"   text NOT NULL,
  "ticket_id"    uuid NOT NULL REFERENCES "support"."tickets" ("id") ON DELETE CASCADE,
  "user_id"      text NOT NULL,
  "status"       text,
  "message_id"   uuid,
  "author_role"  text,
  "occurred_at"  timestamptz NOT NULL,
  "published_at" timestamptz,
  -- Failed publishes back off so one bad row never holds up the rest (no head-of-line block).
  "attempts"        integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz,
  "last_error"      text,
  CONSTRAINT "event_outbox_name_ck" CHECK ("event_name" IN ('supportTicketOpened', 'supportTicketUpdated', 'supportMessageCreated')),
  CONSTRAINT "event_outbox_shape_ck" CHECK (
    ("event_name" = 'supportTicketOpened' AND "status" IS NULL AND "message_id" IS NULL AND "author_role" IS NULL)
    OR ("event_name" = 'supportTicketUpdated' AND "status" IS NOT NULL AND "message_id" IS NULL AND "author_role" IS NULL)
    OR ("event_name" = 'supportMessageCreated' AND "status" IS NULL AND "message_id" IS NOT NULL AND "author_role" IN ('user', 'operator'))
  )
);
CREATE INDEX IF NOT EXISTS "event_outbox_pending_idx" ON "support"."event_outbox" ("next_attempt_at", "occurred_at") WHERE "published_at" IS NULL;

CREATE OR REPLACE FUNCTION "support"."tickets_outbox_opened"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "support"."event_outbox" ("event_key", "event_name", "ticket_id", "user_id", "occurred_at")
  VALUES ('support.ticket.opened:' || NEW."id", 'supportTicketOpened', NEW."id", NEW."user_id", NEW."created_at")
  ON CONFLICT ("event_key") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "tickets_outbox_opened" ON "support"."tickets";
CREATE TRIGGER "tickets_outbox_opened"
  AFTER INSERT ON "support"."tickets"
  FOR EACH ROW EXECUTE FUNCTION "support"."tickets_outbox_opened"();

-- Each status change gets its own number, so two changes inside one transaction
-- (where updated_at = now() is the same instant) never share a key.
CREATE SEQUENCE IF NOT EXISTS "support"."event_outbox_seq";

CREATE OR REPLACE FUNCTION "support"."tickets_outbox_updated"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IS DISTINCT FROM NEW."status" THEN
    INSERT INTO "support"."event_outbox" ("event_key", "event_name", "ticket_id", "user_id", "status", "occurred_at")
    VALUES (
      'support.ticket.updated:' || NEW."id" || ':' || nextval('"support"."event_outbox_seq"'),
      'supportTicketUpdated', NEW."id", NEW."user_id", NEW."status", NEW."updated_at"
    )
    ON CONFLICT ("event_key") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "tickets_outbox_updated" ON "support"."tickets";
CREATE TRIGGER "tickets_outbox_updated"
  AFTER UPDATE OF "status" ON "support"."tickets"
  FOR EACH ROW EXECUTE FUNCTION "support"."tickets_outbox_updated"();

-- support.comments has no internal-note type today (every message is visible to the
-- request owner). If internal notes are ever added, this trigger must skip them.
CREATE OR REPLACE FUNCTION "support"."comments_outbox_created"() RETURNS trigger AS $$
BEGIN
  INSERT INTO "support"."event_outbox" ("event_key", "event_name", "ticket_id", "user_id", "message_id", "author_role", "occurred_at")
  SELECT 'support.message.created:' || NEW."id", 'supportMessageCreated', t."id", t."user_id", NEW."id", NEW."author_role", NEW."created_at"
  FROM "support"."tickets" t WHERE t."id" = NEW."ticket_id"
  ON CONFLICT ("event_key") DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "comments_outbox_created" ON "support"."comments";
CREATE TRIGGER "comments_outbox_created"
  AFTER INSERT ON "support"."comments"
  FOR EACH ROW EXECUTE FUNCTION "support"."comments_outbox_created"();
