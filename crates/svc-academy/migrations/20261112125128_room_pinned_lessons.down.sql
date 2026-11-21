-- intafaced:destructive — reversal of 20261112125128_room_pinned_lessons.sql
-- Drops every room's pinned lessons; the rooms, their sessions and the lessons themselves are kept.
DROP TABLE IF EXISTS "academy"."room_pinned_lessons";
