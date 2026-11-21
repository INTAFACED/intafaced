-- Cannot be reversed once an `assisted` revision is an item's live revision: the DELETE below then breaks the
-- deferred live-revision reference at commit. Republish those items from another revision first.
DELETE FROM "academy"."lesson_revisions" WHERE "source" = 'assisted';
ALTER TABLE "academy"."lesson_revisions" DROP CONSTRAINT IF EXISTS "lesson_revisions_source_chk";
ALTER TABLE "academy"."lesson_revisions"
  ADD CONSTRAINT "lesson_revisions_source_chk" CHECK ("source" IN ('saved', 'reverted', 'duplicated', 'imported'));
DROP TABLE IF EXISTS "academy"."lesson_drafts";
