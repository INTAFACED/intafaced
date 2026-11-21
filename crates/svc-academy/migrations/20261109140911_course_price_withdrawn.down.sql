-- intafaced:destructive — reversal of 20261109140911_course_price_withdrawn.sql
-- A course whose price was withdrawn while published has no price to restore, so the narrowed check stays satisfiable
-- only if those rows are gone; this reversal refuses (the check fails) while any such course remains.
DELETE FROM "academy"."course_events" WHERE "kind" = 'price_withdrawn';
ALTER TABLE "academy"."course_events" DROP CONSTRAINT IF EXISTS "course_events_kind_chk";
ALTER TABLE "academy"."course_events"
  ADD CONSTRAINT "course_events_kind_chk"
  CHECK ("kind" IN ('created', 'updated', 'state', 'outline', 'lesson', 'topics', 'withdrawn'));
ALTER TABLE "academy"."courses" DROP CONSTRAINT IF EXISTS "courses_published_price_chk";
ALTER TABLE "academy"."courses"
  ADD CONSTRAINT "courses_published_price_chk" CHECK ("state" = 'draft' OR "pricing" = 'free' OR "price" IS NOT NULL);
ALTER TABLE "academy"."courses" DROP COLUMN IF EXISTS "price_withdrawn_at";
