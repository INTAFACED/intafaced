-- Handle settings (PP-send-request-03): change the handle under a lifetime cap, and choose whether people can find
-- the account by it.
--
-- handle_discoverable defaults true: every account was findable by exact handle before this column, and turning it
-- off is the owner's own choice. handle_changes counts changes since sign-up; the cap itself is an owner setting
-- (IDENTITY_HANDLE_CHANGE_MAX), never stored here. handle_audit keeps one row per change, written in the same
-- transaction as the change.
--
-- Reversal: 20261029144746_handle_settings.down.sql

ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "handle_discoverable" boolean NOT NULL DEFAULT true;
ALTER TABLE "identity"."users" ADD COLUMN IF NOT EXISTS "handle_changes" integer NOT NULL DEFAULT 0;

ALTER TABLE "identity"."users" DROP CONSTRAINT IF EXISTS "users_handle_changes_ck";
ALTER TABLE "identity"."users" ADD CONSTRAINT "users_handle_changes_ck" CHECK ("handle_changes" >= 0);

CREATE TABLE IF NOT EXISTS "identity"."handle_audit" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "identity"."users"("id"),
  "session_id"  text NOT NULL,
  "event"       text NOT NULL,
  "old_handle"  citext,
  "new_handle"  citext,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "handle_audit_event_ck" CHECK ("event" IN ('changed', 'discoverable_on', 'discoverable_off')),
  CONSTRAINT "handle_audit_changed_ck" CHECK (("event" = 'changed') = ("old_handle" IS NOT NULL AND "new_handle" IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS "handle_audit_user_idx" ON "identity"."handle_audit" ("user_id", "created_at");
