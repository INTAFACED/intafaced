-- svc-academy · lesson content as revisions of ordered blocks (AC-course-structure-03)
-- Reversal: 0021_lesson_revisions.down.sql
--
-- Every save of an item's lesson is a new row keyed by (item, revision), the
-- business key `lesson:<item>:<revision>`. A revert copies an older revision's
-- blocks into a new one; a duplicate starts the copy at revision 1. Learners see
-- the item's `live_revision`, which only an explicit publish moves, so editing
-- after publish never changes what learners read. A `lesson` course event records
-- each publish with who and why. No learner record is written here.

CREATE TABLE IF NOT EXISTS "academy"."lesson_revisions" (
  "item_id"        uuid NOT NULL REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "revision"       integer NOT NULL,
  "source"         text NOT NULL,
  "from_revision"  integer,
  "from_item_id"   uuid,
  "blocks"         jsonb NOT NULL,
  "actor"          uuid NOT NULL,
  "at"             timestamptz NOT NULL,
  PRIMARY KEY ("item_id", "revision"),
  CONSTRAINT "lesson_revisions_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "lesson_revisions_source_chk" CHECK ("source" IN ('saved', 'reverted', 'duplicated', 'imported')),
  CONSTRAINT "lesson_revisions_from_chk" CHECK (("source" = 'reverted') = ("from_revision" IS NOT NULL)
    AND ("source" = 'duplicated') = ("from_item_id" IS NOT NULL)),
  CONSTRAINT "lesson_revisions_blocks_chk" CHECK (jsonb_typeof("blocks") = 'array' AND jsonb_array_length("blocks") > 0)
);

ALTER TABLE "academy"."course_items" ADD COLUMN IF NOT EXISTS "live_revision" integer;
-- The course revision the live revision was published at, so a repeated publish finds its own result.
ALTER TABLE "academy"."course_items" ADD COLUMN IF NOT EXISTS "live_course_revision" integer;
-- A duplicate's source and the course revision it was made at, so a repeated duplicate finds its copy.
ALTER TABLE "academy"."course_items" ADD COLUMN IF NOT EXISTS "copied_from" uuid;
ALTER TABLE "academy"."course_items" ADD COLUMN IF NOT EXISTS "copied_at_revision" integer;
ALTER TABLE "academy"."course_items" DROP CONSTRAINT IF EXISTS "course_items_live_fk";
ALTER TABLE "academy"."course_items"
  ADD CONSTRAINT "course_items_live_fk" FOREIGN KEY ("id", "live_revision")
  REFERENCES "academy"."lesson_revisions" ("item_id", "revision") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "academy"."course_events" DROP CONSTRAINT IF EXISTS "course_events_kind_chk";
ALTER TABLE "academy"."course_events"
  ADD CONSTRAINT "course_events_kind_chk" CHECK ("kind" IN ('created', 'updated', 'state', 'outline', 'lesson'));
