-- Reverse 0018_ticket_on_hold_lifecycle.sql
-- Lossy: waiting-on facts and follow-up links are dropped. The trail is append-only, so a
-- database that already holds an on-hold ticket or an on-hold trail row refuses the reversal
-- rather than rewrite history; move those tickets on and keep the trail.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "support"."tickets" WHERE "status" = 'on_hold')
     OR EXISTS (SELECT 1 FROM "support"."ticket_events" WHERE "from_status" = 'on_hold' OR "to_status" = 'on_hold') THEN
    RAISE EXCEPTION '0018 cannot be reversed while a ticket or trail row uses on_hold';
  END IF;
END $$;

DROP TABLE IF EXISTS "support"."ticket_lifecycle";

CREATE OR REPLACE FUNCTION "support"."tickets_status_transition"() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IS NOT DISTINCT FROM NEW."status" THEN
    RETURN NEW;
  END IF;

  IF OLD."status" = 'open' AND NEW."status" IN ('pending', 'resolved', 'closed') THEN
    RETURN NEW;
  END IF;
  IF OLD."status" = 'pending' AND NEW."status" IN ('open', 'resolved', 'closed') THEN
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

ALTER TABLE "support"."ticket_events" DROP CONSTRAINT IF EXISTS "ticket_events_status_pair_ck";
ALTER TABLE "support"."ticket_events" ADD CONSTRAINT "ticket_events_status_pair_ck"
  CHECK (
    ("kind" <> 'status_changed' AND "from_status" IS NULL AND "to_status" IS NULL)
    OR (
      "kind" = 'status_changed'
      AND "from_status" IS NOT NULL
      AND "to_status" IS NOT NULL
      AND "from_status" IN ('open', 'pending', 'resolved', 'closed')
      AND "to_status" IN ('open', 'pending', 'resolved', 'closed')
      AND "from_status" <> "to_status"
    )
  );

ALTER TABLE "support"."tickets" DROP CONSTRAINT IF EXISTS "tickets_status_ck";
ALTER TABLE "support"."tickets" ADD CONSTRAINT "tickets_status_ck"
  CHECK ("status" IN ('open', 'pending', 'resolved', 'closed'));
