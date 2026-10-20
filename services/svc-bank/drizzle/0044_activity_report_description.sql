-- intafaced:destructive drops only constraints this migration re-adds (idempotent re-run); no data is removed
-- A second free-text field on an activity line, used in reports and exports (PF-activity-03).
--
-- A line may now carry a private note, a report description, or both. `text` (the private note) becomes
-- nullable so a description can be written on its own; each table still requires at least one of the two.
-- The command table keeps what each command wrote, so a replay of the same command id returns the same
-- answer and a changed one is refused.
--
-- Reversal: 0044_activity_report_description.down.sql

ALTER TABLE "bank"."activity_notes" ADD COLUMN IF NOT EXISTS "report_description" text;
ALTER TABLE "bank"."activity_notes" ALTER COLUMN "text" DROP NOT NULL;
ALTER TABLE "bank"."activity_notes" DROP CONSTRAINT IF EXISTS "activity_notes_report_description_len";
ALTER TABLE "bank"."activity_notes" ADD CONSTRAINT "activity_notes_report_description_len"
  CHECK ("report_description" IS NULL OR char_length("report_description") BETWEEN 1 AND 500);
ALTER TABLE "bank"."activity_notes" DROP CONSTRAINT IF EXISTS "activity_notes_has_content";
ALTER TABLE "bank"."activity_notes" ADD CONSTRAINT "activity_notes_has_content"
  CHECK ("text" IS NOT NULL OR "report_description" IS NOT NULL);

ALTER TABLE "bank"."activity_note_commands" ADD COLUMN IF NOT EXISTS "report_description" text;
ALTER TABLE "bank"."activity_note_commands" ALTER COLUMN "text" DROP NOT NULL;
ALTER TABLE "bank"."activity_note_commands" DROP CONSTRAINT IF EXISTS "activity_note_commands_has_content";
ALTER TABLE "bank"."activity_note_commands" ADD CONSTRAINT "activity_note_commands_has_content"
  CHECK ("text" IS NOT NULL OR "report_description" IS NOT NULL);
