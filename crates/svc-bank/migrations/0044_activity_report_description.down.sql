-- Remove the report description. Rows that hold only a description have no private note to keep, so they are
-- deleted: the description is the only thing they carried. Rows with a note keep it.

DELETE FROM "bank"."activity_note_commands" WHERE "text" IS NULL;
DELETE FROM "bank"."activity_notes" WHERE "text" IS NULL;

ALTER TABLE "bank"."activity_note_commands" DROP CONSTRAINT IF EXISTS "activity_note_commands_has_content";
ALTER TABLE "bank"."activity_note_commands" DROP COLUMN IF EXISTS "report_description";
ALTER TABLE "bank"."activity_note_commands" ALTER COLUMN "text" SET NOT NULL;

ALTER TABLE "bank"."activity_notes" DROP CONSTRAINT IF EXISTS "activity_notes_has_content";
ALTER TABLE "bank"."activity_notes" DROP CONSTRAINT IF EXISTS "activity_notes_report_description_len";
ALTER TABLE "bank"."activity_notes" DROP COLUMN IF EXISTS "report_description";
ALTER TABLE "bank"."activity_notes" ALTER COLUMN "text" SET NOT NULL;
