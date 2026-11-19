-- svc-academy · scheduled release and pacing on courses staff make (AC-release-access-01)
-- Reversal: 20261025002915_course_release.down.sql
--
-- A section opens at an instant (UTC) or some whole days after the learner's enrolment; availability is worked out on
-- each read from this rule and the enrolment, never by a timer per learner. A course is self-paced or instructor-paced,
-- fixed once a learner has enrolled. Every change is an event row with who and why. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_section_releases" (
  "section_id"  uuid PRIMARY KEY REFERENCES "academy"."course_sections" ("id") ON DELETE CASCADE,
  "release_at"  timestamptz,
  "after_days"  integer,
  "reason"      text NOT NULL,
  "set_by"      uuid NOT NULL,
  "set_at"      timestamptz NOT NULL,
  CONSTRAINT "course_section_releases_rule_chk" CHECK (
    ("release_at" IS NULL) <> ("after_days" IS NULL) AND ("after_days" IS NULL OR "after_days" BETWEEN 1 AND 365)
  )
);

CREATE TABLE IF NOT EXISTS "academy"."course_pacing" (
  "course_id"  uuid PRIMARY KEY REFERENCES "academy"."courses" ("id") ON DELETE CASCADE,
  "pacing"     text NOT NULL,
  "set_by"     uuid NOT NULL,
  "set_at"     timestamptz NOT NULL,
  CONSTRAINT "course_pacing_chk" CHECK ("pacing" IN ('self_paced', 'instructor_paced'))
);

CREATE TABLE IF NOT EXISTS "academy"."course_release_events" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign keys: the history of who scheduled what outlives a removed section.
  "course_id"   uuid NOT NULL,
  "section_id"  uuid,
  "kind"        text NOT NULL,
  "rule"        jsonb,
  "reason"      text NOT NULL,
  "actor_id"    uuid NOT NULL,
  "at"          timestamptz NOT NULL,
  CONSTRAINT "course_release_events_kind_chk" CHECK ("kind" IN ('section_release', 'pacing'))
);
CREATE INDEX IF NOT EXISTS "course_release_events_course_idx" ON "academy"."course_release_events" ("course_id", "at" DESC);
