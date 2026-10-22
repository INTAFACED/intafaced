-- svc-support · business hours, holidays and the out-of-hours reply (SP-sla-02)
-- Reversal: 0029_support_business_hours.down.sql
--
-- One row holds the desk's IANA time zone, weekly intervals, holidays and out-of-hours reply text. All are blank until
-- the owner sets them: nothing is seeded and no zone, hour or text is built in. Every change is appended to the log
-- under a business key (`support.hours:r<revision>`) with who made it and why; the log refuses update and delete.
-- `out_of_hours_replies` holds one row per request that got the reply, so a request is answered at most once.
-- (0027 is taken by open #5824 and 0028 by the SP-email-01 branch, hence 0029.)

CREATE TABLE IF NOT EXISTS "support"."business_hours" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
  "time_zone" text CHECK ("time_zone" IS NULL OR char_length("time_zone") BETWEEN 1 AND 64),
  "intervals" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("intervals") = 'array'),
  "holidays" jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof("holidays") = 'array'),
  "out_of_hours_reply" text CHECK ("out_of_hours_reply" IS NULL OR char_length("out_of_hours_reply") BETWEEN 1 AND 2000),
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "updated_by" text,
  "updated_at" timestamptz,
  CONSTRAINT "business_hours_zone_ck" CHECK ("time_zone" IS NOT NULL OR jsonb_array_length("intervals") = 0)
);

CREATE TABLE IF NOT EXISTS "support"."business_hours_log" (
  "key" text PRIMARY KEY,
  "fingerprint" text NOT NULL,
  "revision_after" integer NOT NULL UNIQUE CHECK ("revision_after" >= 1),
  "before" jsonb NOT NULL,
  "after" jsonb NOT NULL,
  "set_by" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION "support"."business_hours_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.business_hours_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "business_hours_log_append_only_trg" ON "support"."business_hours_log";
CREATE TRIGGER "business_hours_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."business_hours_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."business_hours_log_append_only"();

CREATE TABLE IF NOT EXISTS "support"."out_of_hours_replies" (
  "ticket_id" uuid PRIMARY KEY REFERENCES "support"."tickets" ("id") ON DELETE CASCADE,
  "replied_at" timestamptz NOT NULL
);
