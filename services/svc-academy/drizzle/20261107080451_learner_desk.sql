-- svc-academy · the staff desk for one learner (J-academy-14: AC-enrolment-03, AC-progress-03, AC-access-grants-01)
-- Reversal: 20261107080451_learner_desk.down.sql
--
-- `access_grants`: the one access record of a learner on a course beside their free enrolment: who may learn what and
-- why, from when, and until when. One row per (course, learner), keyed `grant:<course>:<learner>`; an expiry or a
-- reinstatement moves the same row and appends an event, so the row's history is its events. A reinstatement is keyed
-- `reinstate:<grant>:<n>`. Expiry is decided on read: the first read after the end writes the expired event once.
--
-- `learner_notes`: staff's internal notes on a learner. No learner read selects from it.
-- `learner_tags`: a keyword on a learner; a tag is never renamed, only removed and added again.
-- `learner_events`: every staff change on a learner (a note, a tag, an item marked complete, a voided quiz attempt), with
--   who and why, keyed by the console's request so a replay answers with the stored event.
-- `assessment_attempts` gains a void: a voided attempt keeps its score row and stops counting against the attempt limit,
--   the grade and the pass. Nothing is deleted. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."access_grants" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL,
  "path_slug"   text NOT NULL,
  "source"      text NOT NULL,
  "reason"      text,
  "starts_at"   timestamptz NOT NULL,
  "expires_at"  timestamptz,
  "state"       text NOT NULL,
  "created_at"  timestamptz NOT NULL,
  "updated_at"  timestamptz NOT NULL,
  CONSTRAINT "access_grants_key_uq" UNIQUE ("path_slug", "user_id"),
  CONSTRAINT "access_grants_source_chk" CHECK ("source" IN ('free', 'purchase', 'staff', 'bundle', 'membership')),
  CONSTRAINT "access_grants_state_chk" CHECK ("state" IN ('granted', 'expired', 'revoked')),
  CONSTRAINT "access_grants_reason_chk" CHECK ("source" <> 'staff' OR char_length(btrim(coalesce("reason", ''))) > 0),
  CONSTRAINT "access_grants_window_chk" CHECK ("expires_at" IS NULL OR "expires_at" > "starts_at")
);
CREATE INDEX IF NOT EXISTS "access_grants_user_idx" ON "academy"."access_grants" ("user_id");

CREATE TABLE IF NOT EXISTS "academy"."access_grant_events" (
  "grant_id"    uuid NOT NULL REFERENCES "academy"."access_grants" ("id"),
  "n"           integer NOT NULL,
  "kind"        text NOT NULL,
  "key"         text NOT NULL,
  "reason"      text,
  "actor_id"    uuid,
  "expires_at"  timestamptz,
  "at"          timestamptz NOT NULL,
  PRIMARY KEY ("grant_id", "n"),
  CONSTRAINT "access_grant_events_key_uq" UNIQUE ("key"),
  CONSTRAINT "access_grant_events_n_chk" CHECK ("n" > 0),
  CONSTRAINT "access_grant_events_kind_chk" CHECK ("kind" IN ('granted', 'expired', 'revoked', 'reinstated')),
  CONSTRAINT "access_grant_events_actor_chk" CHECK (("kind" = 'expired') = ("actor_id" IS NULL))
);

CREATE TABLE IF NOT EXISTS "academy"."learner_notes" (
  "user_id"    uuid NOT NULL,
  "n"          integer NOT NULL,
  "body"       text NOT NULL,
  "key"        text NOT NULL,
  "author_id"  uuid NOT NULL,
  "at"         timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "n"),
  CONSTRAINT "learner_notes_key_uq" UNIQUE ("user_id", "key"),
  CONSTRAINT "learner_notes_body_chk" CHECK (char_length(btrim("body")) > 0)
);

CREATE TABLE IF NOT EXISTS "academy"."learner_tags" (
  "tag"       text NOT NULL,
  "user_id"   uuid NOT NULL,
  "added_by"  uuid NOT NULL,
  "added_at"  timestamptz NOT NULL,
  PRIMARY KEY ("tag", "user_id"),
  CONSTRAINT "learner_tags_tag_chk" CHECK ("tag" ~ '^[a-z0-9][a-z0-9-]{0,39}$')
);
CREATE INDEX IF NOT EXISTS "learner_tags_user_idx" ON "academy"."learner_tags" ("user_id");

CREATE TABLE IF NOT EXISTS "academy"."learner_events" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"    uuid NOT NULL,
  "kind"       text NOT NULL,
  "key"        text NOT NULL,
  "item_slug"  text,
  "detail"     text NOT NULL,
  "reason"     text NOT NULL,
  "actor_id"   uuid NOT NULL,
  "at"         timestamptz NOT NULL,
  CONSTRAINT "learner_events_key_uq" UNIQUE ("key"),
  CONSTRAINT "learner_events_kind_chk" CHECK ("kind" IN ('note_added', 'tag_added', 'tag_removed', 'marked_complete', 'quiz_attempt_voided')),
  CONSTRAINT "learner_events_reason_chk" CHECK (char_length(btrim("reason")) > 0)
);
CREATE INDEX IF NOT EXISTS "learner_events_user_idx" ON "academy"."learner_events" ("user_id", "at" DESC);

ALTER TABLE "academy"."assessment_attempts" ADD COLUMN IF NOT EXISTS "voided_at" timestamptz;
ALTER TABLE "academy"."assessment_attempts" ADD COLUMN IF NOT EXISTS "voided_by" uuid;
ALTER TABLE "academy"."assessment_attempts" ADD COLUMN IF NOT EXISTS "void_reason" text;
ALTER TABLE "academy"."assessment_attempts" DROP CONSTRAINT IF EXISTS "assessment_attempts_void_chk";
ALTER TABLE "academy"."assessment_attempts" ADD CONSTRAINT "assessment_attempts_void_chk" CHECK (
  ("voided_at" IS NULL AND "voided_by" IS NULL AND "void_reason" IS NULL)
  OR ("voided_at" IS NOT NULL AND "voided_by" IS NOT NULL AND char_length(btrim(coalesce("void_reason", ''))) > 0)
);
