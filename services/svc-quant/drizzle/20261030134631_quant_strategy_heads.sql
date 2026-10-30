-- svc-quant · strategy heads: name, folder, description and the recycle bin (AL-editor-01)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. These are the head's own fields: renaming or moving a strategy changes the head
-- and adds no version, so strategy_versions stays insert-only. A null name means the head takes its latest version's
-- name. `organised` and `restores` count those head writes, so the screen derives each write's key from what it read.

ALTER TABLE "quant"."strategies" ADD COLUMN IF NOT EXISTS "name" text;
ALTER TABLE "quant"."strategies" ADD COLUMN IF NOT EXISTS "folder" text NOT NULL DEFAULT '';
ALTER TABLE "quant"."strategies" ADD COLUMN IF NOT EXISTS "description" text NOT NULL DEFAULT '';
ALTER TABLE "quant"."strategies" ADD COLUMN IF NOT EXISTS "organised" integer NOT NULL DEFAULT 0;
ALTER TABLE "quant"."strategies" ADD COLUMN IF NOT EXISTS "restores" integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'strategies_head_ck' AND conrelid = '"quant"."strategies"'::regclass
  ) THEN
    ALTER TABLE "quant"."strategies" ADD CONSTRAINT "strategies_head_ck" CHECK (
      ("name" IS NULL OR char_length("name") BETWEEN 1 AND 128)
      AND char_length("folder") <= 40
      AND position('/' in "folder") = 0
      AND char_length("description") <= 500
      AND "organised" >= 0
      AND "restores" >= 0
    );
  END IF;
END
$$;

-- An organise and a restore keep a write receipt like every other studio write, so a lost reply replays.
ALTER TABLE "quant"."write_receipts" DROP CONSTRAINT IF EXISTS "write_receipts_operation_ck";
ALTER TABLE "quant"."write_receipts" ADD CONSTRAINT "write_receipts_operation_ck"
  CHECK ("operation" IN ('create', 'revise', 'delete', 'backtest', 'organise', 'restore'));
