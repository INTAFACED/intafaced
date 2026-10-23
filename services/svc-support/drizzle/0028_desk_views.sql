-- svc-support · saved desk views (SP-desk-01)
-- Reversal: 0028_desk_views.down.sql
--
-- One row per view. Personal and shared caps are owner values and are not stored here. Every save or delete is
-- appended to the log under a business key (`view:<owner>:<name>:r<revision>`); the log refuses update and delete.

CREATE TABLE IF NOT EXISTS "support"."desk_views" (
  "id" uuid PRIMARY KEY,
  "owner_id" uuid NOT NULL,
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 80),
  "shared" boolean NOT NULL,
  "filter" jsonb NOT NULL,
  "sort" jsonb,
  "layout" text CHECK ("layout" IS NULL OR "layout" ~ '^[a-z0-9_-]{1,40}$'),
  "favourite" boolean NOT NULL,
  "revision" integer NOT NULL CHECK ("revision" >= 1),
  "updated_by" text NOT NULL,
  "updated_at" timestamptz NOT NULL,
  UNIQUE ("owner_id", "name")
);

CREATE INDEX IF NOT EXISTS "desk_views_shared_idx" ON "support"."desk_views" ("shared");

CREATE TABLE IF NOT EXISTS "support"."desk_view_log" (
  "key" text PRIMARY KEY,
  "view_id" uuid NOT NULL,
  "fingerprint" text NOT NULL,
  "revision_after" integer NOT NULL CHECK ("revision_after" >= 1),
  "action" text NOT NULL CHECK ("action" IN ('save', 'delete')),
  "after" jsonb NOT NULL,
  "set_by" text NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_at" timestamptz NOT NULL
);

CREATE OR REPLACE FUNCTION "support"."desk_view_log_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'support.desk_view_log is append-only' USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "desk_view_log_append_only_trg" ON "support"."desk_view_log";
CREATE TRIGGER "desk_view_log_append_only_trg"
  BEFORE UPDATE OR DELETE ON "support"."desk_view_log"
  FOR EACH ROW EXECUTE FUNCTION "support"."desk_view_log_append_only"();
