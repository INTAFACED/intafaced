-- Reverse 0030_desk_views.sql
-- Lossy by nature: the views and their log are dropped.

DROP TRIGGER IF EXISTS "desk_view_log_append_only_trg" ON "support"."desk_view_log";
DROP FUNCTION IF EXISTS "support"."desk_view_log_append_only"();
DROP TABLE IF EXISTS "support"."desk_view_log";
DROP TABLE IF EXISTS "support"."desk_views";
