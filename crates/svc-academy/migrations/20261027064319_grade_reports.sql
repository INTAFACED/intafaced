-- svc-academy · time-stamped grade reports of a course staff made (AC-assignments-04, report part)
-- Reversal: 20261027064319_grade_reports.down.sql
--
-- A report is a stored snapshot of the gradebook: its CSV, when and by whom it was made, and the SHA-256 of the CSV.
-- Reports are numbered per course (`gradereport:<course>:<n>`), so a retried request finds the report it made. A
-- download serves the stored CSV; nothing is worked out again. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_grade_reports" (
  "course_id"  uuid NOT NULL REFERENCES "academy"."courses" ("id") ON DELETE CASCADE,
  "n"          integer NOT NULL,
  "csv"        text NOT NULL,
  "sha256"     text NOT NULL,
  "rows"       integer NOT NULL,
  "made_by"    uuid NOT NULL,
  "made_at"    timestamptz NOT NULL,
  PRIMARY KEY ("course_id", "n"),
  CONSTRAINT "course_grade_reports_n_chk" CHECK ("n" >= 1),
  CONSTRAINT "course_grade_reports_sha256_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$')
);
