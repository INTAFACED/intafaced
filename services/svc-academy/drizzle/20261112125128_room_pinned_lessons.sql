-- svc-academy · a specialist room's pinned lessons (RC-academy-06; J-academy-19 #4)
-- Reversal: 20261112125128_room_pinned_lessons.down.sql
--
-- A room's host pins lessons from the curriculum to the room page, in the order pinned. One row per room and lesson; a
-- lesson pinned twice keeps its first place. The lesson is named by its curriculum slug (the catalogue is code, not a
-- table). Deleting the room deletes its pins.

CREATE TABLE IF NOT EXISTS "academy"."room_pinned_lessons" (
  "room_id"    uuid NOT NULL REFERENCES "academy"."rooms" ("id") ON DELETE CASCADE,
  "item_slug"  text NOT NULL,
  "position"   integer NOT NULL,
  "pinned_by"  uuid NOT NULL,
  "pinned_at"  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("room_id", "item_slug"),
  CONSTRAINT "room_pinned_lessons_position_chk" CHECK ("position" >= 0)
);
CREATE INDEX IF NOT EXISTS "room_pinned_lessons_order_idx" ON "academy"."room_pinned_lessons" ("room_id", "position");
