DELETE FROM "academy"."lesson_revisions" WHERE "source" = 'assisted';
ALTER TABLE "academy"."lesson_revisions" DROP CONSTRAINT IF EXISTS "lesson_revisions_source_chk";
ALTER TABLE "academy"."lesson_revisions"
  ADD CONSTRAINT "lesson_revisions_source_chk" CHECK ("source" IN ('saved', 'reverted', 'duplicated', 'imported'));
DROP TABLE IF EXISTS "academy"."lesson_drafts";
