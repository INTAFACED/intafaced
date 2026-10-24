-- Payment reminders and standing-order notices (BK-acct-10, J-bank-06 #6).
--
-- `reminder_rules`: one rule per person, business key `reminder:<user_id>`. `lead_hours` is how long before a standing
-- order runs the person wants to hear about it, from the fixed choices the service offers; NULL is off. A write names
-- the revision it read; the same client request sent again reads back the row it made.
--
-- `scheduled_notices`: the outbox. One row per (schedule, occurrence, kind) is owed until the bus takes it
-- (`announced_at`), so a job that runs twice tells a person once and a lost publish is sent again. A reminder is about a
-- run that has not happened; a failure notice is about a run svc-bank already recorded as rejected. Neither moves value,
-- and no amount is stored here: the publisher reads it from the order or the run.
CREATE TABLE IF NOT EXISTS "bank"."reminder_rules" (
  "user_id"            text PRIMARY KEY,
  "rule_key"           text NOT NULL,
  "lead_hours"         integer,
  "revision"           integer NOT NULL DEFAULT 1,
  "client_request_id"  text NOT NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "reminder_rules_key_uq" UNIQUE ("rule_key"),
  CONSTRAINT "reminder_rules_key_ck" CHECK ("rule_key" = 'reminder:' || "user_id"),
  CONSTRAINT "reminder_rules_lead_ck" CHECK ("lead_hours" IS NULL OR "lead_hours" IN (24, 48, 72, 168)),
  CONSTRAINT "reminder_rules_revision_ck" CHECK ("revision" >= 1)
);

CREATE TABLE IF NOT EXISTS "bank"."scheduled_notices" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_id"   uuid NOT NULL REFERENCES "bank"."scheduled_transfers"("id"),
  "occurrence"    integer NOT NULL,
  "kind"          text NOT NULL,
  "user_id"       text NOT NULL,
  -- The run's date for a reminder, the run's attempt for a failure.
  "due_at"        timestamptz NOT NULL,
  -- The lead time a reminder was sent under; NULL for a failure notice.
  "lead_hours"    integer,
  "reason_code"   text,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "announced_at"  timestamptz,
  CONSTRAINT "scheduled_notices_once_uq" UNIQUE ("schedule_id", "occurrence", "kind"),
  CONSTRAINT "scheduled_notices_kind_ck" CHECK ("kind" IN ('reminder', 'failed')),
  CONSTRAINT "scheduled_notices_shape_ck" CHECK (
    ("kind" = 'reminder' AND "lead_hours" IS NOT NULL AND "reason_code" IS NULL)
    OR ("kind" = 'failed' AND "lead_hours" IS NULL AND "reason_code" IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS "scheduled_notices_owed_idx" ON "bank"."scheduled_notices" ("created_at") WHERE "announced_at" IS NULL;
CREATE INDEX IF NOT EXISTS "scheduled_notices_user_idx" ON "bank"."scheduled_notices" ("user_id", "created_at");
