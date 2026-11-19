-- intafaced:destructive — reversal of 0024_learn_hub.sql
DELETE FROM "academy"."course_events" WHERE "kind" IN ('topics', 'withdrawn');
ALTER TABLE "academy"."course_events" DROP CONSTRAINT IF EXISTS "course_events_kind_chk";
ALTER TABLE "academy"."course_events"
  ADD CONSTRAINT "course_events_kind_chk" CHECK ("kind" IN ('created', 'updated', 'state', 'outline', 'lesson'));
DROP TABLE IF EXISTS "academy"."course_topics";
DROP TABLE IF EXISTS "academy"."topics";
DROP TABLE IF EXISTS "academy"."featured_events";
DELETE FROM "academy"."featured_items" WHERE "course_item_id" IS NOT NULL;
ALTER TABLE "academy"."featured_items" DROP CONSTRAINT IF EXISTS "featured_items_one_chk";
ALTER TABLE "academy"."featured_items" DROP COLUMN IF EXISTS "course_item_id";
ALTER TABLE "academy"."featured_items" ALTER COLUMN "item_slug" SET NOT NULL;
