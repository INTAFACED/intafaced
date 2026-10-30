-- Reverse 20261029180000_internal_notes.sql
-- Lossy by nature: internal notes are deleted first, so no staff-only note becomes a public comment.

DELETE FROM "support"."comments" WHERE "visibility" = 'internal';
-- Their receipts go too: a receipt left behind would answer a later note's key with a comment that no longer exists.
DELETE FROM "support"."write_receipts" WHERE "procedure" = 'support.note';
ALTER TABLE "support"."comments" DROP CONSTRAINT IF EXISTS "comments_visibility_ck";
ALTER TABLE "support"."comments" DROP COLUMN IF EXISTS "visibility";
