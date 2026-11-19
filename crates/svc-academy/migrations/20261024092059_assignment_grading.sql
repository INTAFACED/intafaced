-- svc-academy · staff grading of assignment hand-ins (AC-assignments-02)
-- Reversal: 20261024092059_assignment_grading.down.sql
--
-- A grade is an append-only trail of events on one hand-in, keyed `grade:<submission>:<n>`: the score as a decimal no
-- higher than the points the assignment was worth when it was graded (kept on the event, so a later brief cannot turn
-- 8 of 10 into 8 of 5), an optional comment, the grader, and a reason when it overrides an earlier grade.
-- The grade a learner sees is the newest event. A grader takes a lease on a hand-in (holder and expiry, the owner's lease
-- length) so two graders never grade it at once. A learner marking the feedback read is its own row and changes no
-- grade. Graders see learners under a per-assignment alias, worked out on read, never stored. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."assignment_grade_events" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "submission_id"  uuid NOT NULL REFERENCES "academy"."assignment_submissions" ("id"),
  "n"              integer NOT NULL,
  "score"          numeric(8, 2) NOT NULL,
  "points"         numeric(8, 2) NOT NULL,
  "comment"        text,
  "actor"          uuid NOT NULL,
  "reason"         text,
  "at"             timestamptz NOT NULL,
  CONSTRAINT "assignment_grade_events_key_uq" UNIQUE ("submission_id", "n"),
  CONSTRAINT "assignment_grade_events_n_chk" CHECK ("n" > 0),
  CONSTRAINT "assignment_grade_events_score_chk" CHECK ("score" >= 0 AND "score" <= "points"),
  CONSTRAINT "assignment_grade_events_override_chk" CHECK ("n" = 1 OR "reason" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "academy"."assignment_grader_leases" (
  "submission_id"  uuid PRIMARY KEY REFERENCES "academy"."assignment_submissions" ("id"),
  "holder"         uuid NOT NULL,
  "expires_at"     timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "academy"."assignment_feedback_reads" (
  "grade_event_id" uuid PRIMARY KEY REFERENCES "academy"."assignment_grade_events" ("id"),
  "user_id"        uuid NOT NULL,
  "read_at"        timestamptz NOT NULL
);
