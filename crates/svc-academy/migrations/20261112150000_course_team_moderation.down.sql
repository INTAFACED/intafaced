-- intafaced:destructive — reversal of 20261112140000_course_team_moderation.sql
-- Drops every course role, custom role, role change, report and moderation event; deleted posts show to learners again.
DROP TABLE IF EXISTS "academy"."moderation_events";
DROP TABLE IF EXISTS "academy"."discussion_reports";
ALTER TABLE "academy"."discussion_posts" DROP CONSTRAINT IF EXISTS "discussion_posts_removed_chk";
ALTER TABLE "academy"."discussion_posts" DROP COLUMN IF EXISTS "removed_reason";
ALTER TABLE "academy"."discussion_posts" DROP COLUMN IF EXISTS "removed_by";
ALTER TABLE "academy"."discussion_posts" DROP COLUMN IF EXISTS "removed_at";
DROP TABLE IF EXISTS "academy"."team_roles";
DROP TABLE IF EXISTS "academy"."team_changes";
DROP TABLE IF EXISTS "academy"."custom_role_events";
DROP TABLE IF EXISTS "academy"."custom_roles";
