-- svc-academy · course team roles and discussion moderation (AC-roles-01, AC-rooms-02; J-academy-18)
-- Reversal: 20261112140000_course_team_moderation.down.sql
--
-- Custom roles built from the published permission list, switched off without removing holders. Role holders per course
-- (or academy-wide, scope 'academy'). Every role change is proposed by one founder and confirmed by a different one; the
-- change rows are the record. A learner's report of a post, one per account per post. A deleted post keeps its row with
-- who deleted it, when and why, and leaves every learner read. Every moderation action is an append-only event, and each
-- one that tells an author leaves an outbox row until the bus took it. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."custom_roles" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"        text NOT NULL UNIQUE,
  "permissions" text[] NOT NULL,
  "active"      boolean NOT NULL,
  "request_key" text NOT NULL UNIQUE,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL,
  CONSTRAINT "custom_roles_name_chk" CHECK ("name" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$' AND length("name") BETWEEN 3 AND 48),
  CONSTRAINT "custom_roles_permissions_chk" CHECK (cardinality("permissions") >= 1)
);

CREATE TABLE IF NOT EXISTS "academy"."custom_role_events" (
  "id"          bigserial PRIMARY KEY,
  "role_id"     uuid NOT NULL REFERENCES "academy"."custom_roles" ("id"),
  "action"      text NOT NULL,
  "operator_id" uuid NOT NULL,
  "reason"      text NOT NULL,
  "recorded_at" timestamptz NOT NULL,
  CONSTRAINT "custom_role_events_action_chk" CHECK ("action" IN ('created', 'switched_off', 'switched_on')),
  CONSTRAINT "custom_role_events_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS "academy"."team_changes" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- a course id, or 'academy' for an academy-wide role
  "scope"        text NOT NULL,
  "kind"         text NOT NULL,
  "account_id"   uuid NOT NULL,
  "role"         text NOT NULL,
  "reason"       text NOT NULL,
  "request_key"  text NOT NULL UNIQUE,
  "proposed_by"  uuid NOT NULL,
  "proposed_at"  timestamptz NOT NULL,
  "confirmed_by" uuid,
  "confirmed_at" timestamptz,
  CONSTRAINT "team_changes_kind_chk" CHECK ("kind" IN ('assign', 'revoke')),
  CONSTRAINT "team_changes_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "team_changes_confirm_chk" CHECK (
    ("confirmed_by" IS NULL AND "confirmed_at" IS NULL)
    OR ("confirmed_by" IS NOT NULL AND "confirmed_at" IS NOT NULL AND "confirmed_by" <> "proposed_by")
  )
);
CREATE INDEX IF NOT EXISTS "team_changes_scope_idx" ON "academy"."team_changes" ("scope", "proposed_at" DESC);

CREATE TABLE IF NOT EXISTS "academy"."team_roles" (
  "scope"      text NOT NULL,
  "account_id" uuid NOT NULL,
  "role"       text NOT NULL,
  "change_id"  uuid NOT NULL REFERENCES "academy"."team_changes" ("id"),
  "since"      timestamptz NOT NULL,
  PRIMARY KEY ("scope", "account_id", "role")
);
CREATE INDEX IF NOT EXISTS "team_roles_account_idx" ON "academy"."team_roles" ("account_id");

ALTER TABLE "academy"."discussion_posts" ADD COLUMN IF NOT EXISTS "removed_at" timestamptz;
ALTER TABLE "academy"."discussion_posts" ADD COLUMN IF NOT EXISTS "removed_by" uuid;
ALTER TABLE "academy"."discussion_posts" ADD COLUMN IF NOT EXISTS "removed_reason" text;
ALTER TABLE "academy"."discussion_posts" DROP CONSTRAINT IF EXISTS "discussion_posts_removed_chk";
ALTER TABLE "academy"."discussion_posts" ADD CONSTRAINT "discussion_posts_removed_chk" CHECK (
  ("removed_at" IS NULL AND "removed_by" IS NULL AND "removed_reason" IS NULL)
  OR ("removed_at" IS NOT NULL AND "removed_by" IS NOT NULL AND length(btrim("removed_reason")) BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS "academy"."discussion_reports" (
  "post_id"     uuid NOT NULL REFERENCES "academy"."discussion_posts" ("id"),
  "reporter_id" uuid NOT NULL,
  "reason"      text NOT NULL,
  "created_at"  timestamptz NOT NULL,
  PRIMARY KEY ("post_id", "reporter_id"),
  CONSTRAINT "discussion_reports_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500)
);

CREATE TABLE IF NOT EXISTS "academy"."moderation_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"   uuid NOT NULL REFERENCES "academy"."courses" ("id"),
  "action"      text NOT NULL,
  "post_id"     uuid REFERENCES "academy"."discussion_posts" ("id"),
  "author_id"   uuid NOT NULL,
  "posts"       integer NOT NULL,
  "actor_id"    uuid NOT NULL,
  "reason"      text NOT NULL,
  "event_key"   text NOT NULL UNIQUE,
  "recorded_at" timestamptz NOT NULL,
  -- set once the bus took the author's notice; null while it waits
  "notified_at" timestamptz,
  CONSTRAINT "moderation_events_action_chk" CHECK ("action" IN ('delete', 'bulk_delete')),
  CONSTRAINT "moderation_events_reason_chk" CHECK (length(btrim("reason")) BETWEEN 1 AND 500),
  CONSTRAINT "moderation_events_posts_chk" CHECK ("posts" >= 0)
);
CREATE INDEX IF NOT EXISTS "moderation_events_course_idx" ON "academy"."moderation_events" ("course_id", "recorded_at" DESC);
CREATE INDEX IF NOT EXISTS "moderation_events_unsent_idx" ON "academy"."moderation_events" ("recorded_at") WHERE "notified_at" IS NULL;
