DELETE FROM "academy"."course_events" WHERE "kind" = 'outline';
ALTER TABLE "academy"."course_events" DROP CONSTRAINT IF EXISTS "course_events_kind_chk";
ALTER TABLE "academy"."course_events"
  ADD CONSTRAINT "course_events_kind_chk" CHECK ("kind" IN ('created', 'updated', 'state'));
DROP TABLE IF EXISTS "academy"."course_items";
DROP TABLE IF EXISTS "academy"."course_sections";
