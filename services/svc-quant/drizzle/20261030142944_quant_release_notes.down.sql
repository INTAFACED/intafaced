-- Reverses the release notes migration (AL-editor-01). Every note is lost; the versions themselves are untouched.
ALTER TABLE "quant"."strategy_versions" DROP CONSTRAINT IF EXISTS "strategy_versions_release_note_ck";
ALTER TABLE "quant"."strategy_versions" DROP COLUMN IF EXISTS "release_note";
