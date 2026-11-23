-- intafaced:destructive — reversal of 20261030125407_bulk_grade_files.sql
DROP INDEX IF EXISTS "academy"."assignment_grade_events_bulk_uq";
ALTER TABLE "academy"."assignment_grade_events" DROP COLUMN IF EXISTS "bulk_id";
DROP TABLE IF EXISTS "academy"."assignment_bulk_grades";
