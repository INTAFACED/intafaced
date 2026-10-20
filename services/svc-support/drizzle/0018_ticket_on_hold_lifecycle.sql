-- svc-support · on-hold status and ticket lifecycle facts (SP-tickets-04)
-- Reversal: 0018_ticket_on_hold_lifecycle.down.sql
--
-- Adds `on_hold` to the status check on tickets (0000), to the status pair check on the
-- trail (0006) and to the transition trigger (0002). Nothing is dropped. Then a table
-- beside the ticket for who it waits on, when the first public reply went out, and the
-- closed request a new one follows. Staff read it; the ticket owner reads the ticket row.

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_status_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_status_ck"
  CHECK ("status" IN ('open', 'pending', 'on_hold', 'resolved', 'closed'));

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_status_pair_ck";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_status_pair_ck"
  CHECK (
    ("kind" <> 'status_changed' AND "from_status" IS NULL AND "to_status" IS NULL)
    OR (
      "kind" = 'status_changed'
      AND "from_status" IS NOT NULL
      AND "to_status" IS NOT NULL
      AND "from_status" IN ('open', 'pending', 'on_hold', 'resolved', 'closed')
      AND "to_status" IN ('open', 'pending', 'on_hold', 'resolved', 'closed')
      AND "from_status" <> "to_status"
    )
  );

CREATE OR REPLACE FUNCTION "support"."tickets_status_transition"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
    RETURN NEW;
  END IF;

  -- Edges mirror services/svc-support/src/lifecycle.ts TICKET_TRANSITIONS.
  IF OLD."status" = 'open' AND NEW."status" IN ('pending', 'on_hold', 'resolved', 'closed') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" IN ('open', 'on_hold', 'resolved', 'closed') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'on_hold' AND NEW."status" IN ('open', 'pending', 'resolved', 'closed') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'resolved' AND NEW."status" IN ('open', 'closed') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'closed' THEN
    RAISE EXCEPTION 'ticket % is closed: closed is terminal (attempted %)', OLD."id", NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;

  RAISE EXCEPTION 'ticket % illegal status transition % → %', OLD."id", OLD."status", NEW."status"
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS "support"."ticket_lifecycle" (
  "ticket_id" uuid PRIMARY KEY REFERENCES "support"."tickets" ("id") ON DELETE CASCADE,
  "waiting_on" text CHECK ("waiting_on" IS NULL OR "waiting_on" IN ('team', 'customer')),
  "waiting_since" timestamptz,
  "first_public_reply_at" timestamptz,
  "follows_ticket_id" uuid REFERENCES "support"."tickets" ("id"),
  "updated_at" timestamptz NOT NULL,
  CONSTRAINT "ticket_lifecycle_waiting_pair_ck" CHECK (("waiting_on" IS NULL) = ("waiting_since" IS NULL)),
  CONSTRAINT "ticket_lifecycle_not_self_ck" CHECK ("follows_ticket_id" IS NULL OR "follows_ticket_id" <> "ticket_id")
);
CREATE INDEX IF NOT EXISTS "ticket_lifecycle_follows_idx" ON "support"."ticket_lifecycle" ("follows_ticket_id") WHERE "follows_ticket_id" IS NOT NULL;
