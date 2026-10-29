-- svc-support · desk macros and agent signatures (SP-desk-02)
-- Reversal: 20261029161000_desk_macros.down.sql
--
-- One row per macro, written at a revision by a support lead; every write is appended to the log with who and why, and
-- the log refuses update and delete. One signature per staff member, written only by that person at a revision.

CREATE TABLE IF NOT EXISTS "support"."desk_macros" (
  "id" uuid PRIMARY KEY,
  "name" text NOT NULL UNIQUE CHECK (char_length("name") BETWEEN 1 AND 80),
  "folder" text CHECK ("folder" IS NULL OR char_length("folder") BETWEEN 1 AND 80),
  "body" text NOT NULL CHECK (char_length("body") BETWEEN 1 AND 5000),
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "support"."desk_macro_log" (
  "macro_id" uuid NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "fingerprint" text NOT NULL,
  "after" jsonb NOT NULL,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "at" timestamptz NOT NULL,
  PRIMARY KEY ("macro_id", "revision")
);

CREATE OR REPLACE FUNCTION "support"."desk_macro_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.desk_macro_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "desk_macro_log_append_only_trg" ON "support"."desk_macro_log";
CREATE TRIGGER "desk_macro_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."desk_macro_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."desk_macro_log_append_only"();

CREATE TABLE IF NOT EXISTS "support"."staff_signatures" (
  "user_id" text PRIMARY KEY,
  "signature" text NOT NULL CHECK (char_length("signature") BETWEEN 1 AND 500),
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "updated_at" timestamptz NOT NULL
);
