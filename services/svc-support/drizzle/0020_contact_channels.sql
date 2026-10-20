-- svc-support · owner-set contact channels (SP-help-centre-01)
-- Reversal: 0020_contact_channels.down.sql
--
-- One row holds the support email, phone and chat hours. Each is NULL until the owner sets it: nothing is seeded and no
-- address, number or hour is built in. Every change is appended to the log under a business key (`support.contact:r<revision>`)
-- with who made it and why, and the log refuses update and delete.

CREATE TABLE IF NOT EXISTS "support"."contact_channels" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
  "email" text CHECK ("email" IS NULL OR char_length("email") BETWEEN 3 AND 254),
  "phone" text CHECK ("phone" IS NULL OR char_length("phone") BETWEEN 5 AND 32),
  "chat_hours" text CHECK ("chat_hours" IS NULL OR char_length("chat_hours") BETWEEN 1 AND 120),
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "updated_by" text,
  "updated_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "support"."contact_channel_log" (
  "key" text PRIMARY KEY,
  "fingerprint" text NOT NULL,
  "revision_after" integer NOT NULL UNIQUE CHECK ("revision_after" >= 1),
  "before" jsonb NOT NULL,
  "after" jsonb NOT NULL,
  "set_by" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION "support"."contact_channel_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.contact_channel_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "contact_channel_log_append_only_trg" ON "support"."contact_channel_log";
CREATE TRIGGER "contact_channel_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."contact_channel_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."contact_channel_log_append_only"();
