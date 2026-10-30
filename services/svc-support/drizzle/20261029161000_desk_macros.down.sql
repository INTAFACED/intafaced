-- Reverse 20261029161000_desk_macros.sql
-- Lossy by nature: the macros, their log and the signatures are dropped.

DROP TABLE IF EXISTS "support"."staff_signatures";
DROP TRIGGER IF EXISTS "desk_macro_log_append_only_trg" ON "support"."desk_macro_log";
DROP FUNCTION IF EXISTS "support"."desk_macro_log_append_only"();
DROP TABLE IF EXISTS "support"."desk_macro_log";
DROP TABLE IF EXISTS "support"."desk_macros";
