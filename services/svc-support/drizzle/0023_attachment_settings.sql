-- svc-support · owner-set ticket attachment limits (SP-tickets-02)
-- Reversal: 0023_attachment_settings.down.sql
--
-- One row holds the largest file, the allowed content types and the number of files one request may hold. Each is NULL
-- until the owner sets it: nothing is seeded and no size, count or type is built in. Every change is appended to the log
-- under a business key (`support.attachment_settings:r<revision>`) with who made it and why, and the log refuses update
-- and delete. The store and the scanner are deployment configuration and are not rows here.

CREATE TABLE IF NOT EXISTS "support"."attachment_settings" (
  "singleton" boolean PRIMARY KEY DEFAULT true CHECK ("singleton"),
  "max_bytes" integer CHECK ("max_bytes" IS NULL OR "max_bytes" >= 1),
  "allowed_types" text[] CHECK ("allowed_types" IS NULL OR cardinality("allowed_types") >= 1),
  "max_count" integer CHECK ("max_count" IS NULL OR "max_count" >= 1),
  "revision" integer NOT NULL DEFAULT 0 CHECK ("revision" >= 0),
  "updated_by" text,
  "updated_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "support"."attachment_settings_log" (
  "key" text PRIMARY KEY,
  "fingerprint" text NOT NULL,
  "revision_after" integer NOT NULL UNIQUE CHECK ("revision_after" >= 1),
  "before" jsonb NOT NULL,
  "after" jsonb NOT NULL,
  "set_by" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION "support"."attachment_settings_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.attachment_settings_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "attachment_settings_log_append_only_trg" ON "support"."attachment_settings_log";
CREATE TRIGGER "attachment_settings_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."attachment_settings_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."attachment_settings_log_append_only"();
