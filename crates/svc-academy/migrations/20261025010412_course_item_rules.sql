-- svc-academy · prerequisites and per-learner due dates on courses staff make (AC-release-access-02)
-- Reversal: 20261025010412_course_item_rules.down.sql
--
-- An assignment or quiz may require earlier assignments or quizzes of the same course; a cycle is refused before it is
-- written. Staff may move one learner's due date on an assignment later, with a reason. Every change is an event row
-- with who and why. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_item_prerequisites" (
  "item_id"          uuid NOT NULL REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "prerequisite_id"  uuid NOT NULL REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("item_id", "prerequisite_id"),
  CONSTRAINT "course_item_prerequisites_self_chk" CHECK ("item_id" <> "prerequisite_id")
);
CREATE INDEX IF NOT EXISTS "course_item_prerequisites_prereq_idx" ON "academy"."course_item_prerequisites" ("prerequisite_id");

-- Who last set an item's prerequisites and why; no row while none were ever set.
CREATE TABLE IF NOT EXISTS "academy"."course_item_prerequisite_sets" (
  "item_id"  uuid PRIMARY KEY REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "reason"   text NOT NULL,
  "set_by"   uuid NOT NULL,
  "set_at"   timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "academy"."course_item_extensions" (
  "item_id"     uuid NOT NULL REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "user_id"     uuid NOT NULL,
  "due_at"      timestamptz NOT NULL,
  "reason"      text NOT NULL,
  "granted_by"  uuid NOT NULL,
  "granted_at"  timestamptz NOT NULL,
  PRIMARY KEY ("item_id", "user_id")
);

CREATE TABLE IF NOT EXISTS "academy"."course_item_rule_events" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign keys: the history of who set what outlives a removed item.
  "item_id"    uuid NOT NULL,
  "kind"       text NOT NULL,
  "user_id"    uuid,
  "detail"     jsonb NOT NULL,
  "reason"     text NOT NULL,
  "actor_id"   uuid NOT NULL,
  "at"         timestamptz NOT NULL,
  CONSTRAINT "course_item_rule_events_kind_chk" CHECK ("kind" IN ('prerequisites', 'extension'))
);
CREATE INDEX IF NOT EXISTS "course_item_rule_events_item_idx" ON "academy"."course_item_rule_events" ("item_id", "at" DESC);
