DELETE FROM "academy"."course_events" WHERE "kind" = 'lesson';
ALTER TABLE "academy"."course_events" DROP CONSTRAINT IF EXISTS "course_events_kind_chk";
ALTER TABLE "academy"."course_events"
  ADD CONSTRAINT "course_events_kind_chk" CHECK ("kind" IN ('created', 'updated', 'state', 'outline'));
ALTER TABLE "academy"."course_items" DROP CONSTRAINT IF EXISTS "course_items_live_fk";
ALTER TABLE "academy"."course_items" DROP COLUMN IF EXISTS "live_revision";
DROP TABLE IF EXISTS "academy"."lesson_revisions";
