-- svc-academy · bulk grading of assignment hand-ins by file (AC-assignments-02)
-- Reversal: 20261030125407_bulk_grade_files.down.sql
--
-- A grader uploads a file of rows (learner alias, score, comment, reason) for one assignment. The file is stored once per
-- assignment by the sha256 of its bytes: the same file again answers with the stored result and changes nothing. Each
-- good row is a grade event on the trail (`grade:<submission>:<file hash>`), pointing back at the file; each bad row is
-- listed in the stored result with its line and the reason it was refused. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."assignment_bulk_grades" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"     uuid NOT NULL,
  "sha256"      text NOT NULL,
  "actor"       uuid NOT NULL,
  "result"      jsonb NOT NULL,
  "at"          timestamptz NOT NULL,
  CONSTRAINT "assignment_bulk_grades_file_uq" UNIQUE ("item_id", "sha256"),
  CONSTRAINT "assignment_bulk_grades_sha_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);

ALTER TABLE "academy"."assignment_grade_events" ADD COLUMN IF NOT EXISTS "bulk_id" uuid REFERENCES "academy"."assignment_bulk_grades" ("id");
CREATE UNIQUE INDEX IF NOT EXISTS "assignment_grade_events_bulk_uq" ON "academy"."assignment_grade_events" ("submission_id", "bulk_id")
  WHERE "bulk_id" IS NOT NULL;
