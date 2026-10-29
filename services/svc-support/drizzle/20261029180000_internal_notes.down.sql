-- Reverse 20261029180000_internal_notes.sql
-- Lossy by nature: internal notes are deleted first, so no staff-only note becomes a public comment.

DELETE FROM "support"."comments" WHERE "visibility" = 'internal';
ALTER TABLE "support"."comments" DROP CONSTRAINT IF EXISTS "comments_visibility_ck";
ALTER TABLE "support"."comments" DROP COLUMN IF EXISTS "visibility";
