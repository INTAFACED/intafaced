-- svc-academy · the Learn hub's featured article and topics (AC-articles-01)
-- Reversal: 0024_learn_hub.down.sql
-- intafaced:destructive item_slug drops NOT NULL: a course lesson can fill the slot instead; featured_items_one_chk keeps exactly one of the two set.
--
-- The featured slot holds either a curriculum item (by slug, as before) or a
-- course lesson (by id). A course lesson leaves the slot when it is withdrawn
-- from learners, and with its item. Topics are staff-owned names with an
-- address that is never an Academy tab; a course is filed under some of them.

ALTER TABLE "academy"."featured_items" ALTER COLUMN "item_slug" DROP NOT NULL;
ALTER TABLE "academy"."featured_items"
  ADD COLUMN IF NOT EXISTS "course_item_id" uuid REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE;
ALTER TABLE "academy"."featured_items" DROP CONSTRAINT IF EXISTS "featured_items_one_chk";
ALTER TABLE "academy"."featured_items"
  ADD CONSTRAINT "featured_items_one_chk" CHECK (("item_slug" IS NULL) <> ("course_item_id" IS NULL));

-- Every choice and clear of the featured slot, with who and why (the slot row
-- itself holds only the current choice).
CREATE TABLE IF NOT EXISTS "academy"."featured_events" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slot"            text NOT NULL,
  "action"          text NOT NULL,
  "item_slug"       text,
  "course_item_id"  uuid,
  "reason"          text NOT NULL,
  "actor"           uuid NOT NULL,
  "at"              timestamptz NOT NULL,
  CONSTRAINT "featured_events_action_chk" CHECK ("action" IN ('featured', 'cleared', 'withdrawn')),
  CONSTRAINT "featured_events_reason_chk" CHECK (char_length(btrim("reason")) > 0)
);

CREATE TABLE IF NOT EXISTS "academy"."topics" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"        text NOT NULL UNIQUE,
  "name"        text NOT NULL,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL,
  CONSTRAINT "topics_slug_chk" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT "topics_slug_not_tab_chk"
    CHECK ("slug" NOT IN ('learning', 'certificates', 'rooms', 'videos', 'programmes', 'progress')),
  CONSTRAINT "topics_name_chk" CHECK (char_length(btrim("name")) > 0)
);

CREATE TABLE IF NOT EXISTS "academy"."course_topics" (
  "course_id"  uuid NOT NULL REFERENCES "academy"."courses" ("id") ON DELETE CASCADE,
  "topic_id"   uuid NOT NULL REFERENCES "academy"."topics" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("course_id", "topic_id")
);
CREATE INDEX IF NOT EXISTS "course_topics_topic_idx" ON "academy"."course_topics" ("topic_id");

ALTER TABLE "academy"."course_events" DROP CONSTRAINT IF EXISTS "course_events_kind_chk";
ALTER TABLE "academy"."course_events"
  ADD CONSTRAINT "course_events_kind_chk" CHECK ("kind" IN ('created', 'updated', 'state', 'outline', 'lesson', 'topics', 'withdrawn'));
