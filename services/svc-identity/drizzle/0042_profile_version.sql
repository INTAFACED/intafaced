-- svc-identity · customer profile edit (IDENTACCT).
-- Reversal: 0042_profile_version.down.sql.
--
-- `version` is the compare-and-set token for profile.update. Existing rows
-- start at 0. The audit table records field names and the old and new display
-- name. It has no secret column.
ALTER TABLE "identity"."profiles" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "identity"."profile_audit" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid NOT NULL REFERENCES "identity"."users"(id) ON DELETE CASCADE,
  "session_id"       uuid NOT NULL,
  "fields"           text[] NOT NULL,
  "old_display_name" text,
  "new_display_name" text,
  "old_locale"       text,
  "new_locale"       text,
  "created_at"       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "profile_audit_user_idx"
  ON "identity"."profile_audit" ("user_id", "created_at");
