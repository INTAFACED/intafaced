-- svc-quant · release notes on strategy versions (AL-editor-01)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. Each version keeps the note written when it was saved; blank is no note. The
-- owner's length cap (QUANT_RELEASE_NOTE_MAX) is checked by the service; 2000 characters is the column's own ceiling.
-- Adding a column with a default rewrites no row, so the insert-only trigger on strategy_versions is untouched.

ALTER TABLE "quant"."strategy_versions" ADD COLUMN IF NOT EXISTS "release_note" text NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'strategy_versions_release_note_ck' AND conrelid = '"quant"."strategy_versions"'::regclass
  ) THEN
    ALTER TABLE "quant"."strategy_versions"
      ADD CONSTRAINT "strategy_versions_release_note_ck" CHECK (char_length("release_note") <= 2000);
  END IF;
END
$$;
