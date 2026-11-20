-- svc-academy · the late policy of a course staff made (AC-assignments-04, late policy part; ENGINE GR-5)
-- Reversal: 20261031044841_course_late_policies.down.sql
--
-- A course may have one late policy: a grace period in hours and a deduction per day late, as a fraction of the
-- assignment's points, both entered by staff. The entered grade is kept as it is; the late score is worked out from it on
-- each read. A cleared policy keeps its row with both values null, so the revision goes on. Every save is an event row
-- with who and why. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_late_policies" (
  "course_id"          uuid PRIMARY KEY REFERENCES "academy"."courses" ("id") ON DELETE CASCADE,
  "revision"           integer NOT NULL,
  "grace_hours"        numeric(8, 2),
  "deduction_per_day"  numeric(5, 4),
  "reason"             text NOT NULL,
  "set_by"             uuid NOT NULL,
  "set_at"             timestamptz NOT NULL,
  CONSTRAINT "course_late_policies_revision_chk" CHECK ("revision" >= 1),
  CONSTRAINT "course_late_policies_pair_chk" CHECK (("grace_hours" IS NULL) = ("deduction_per_day" IS NULL)),
  CONSTRAINT "course_late_policies_values_chk" CHECK (
    "grace_hours" IS NULL OR ("grace_hours" >= 0 AND "deduction_per_day" > 0 AND "deduction_per_day" <= 1)
  )
);

CREATE TABLE IF NOT EXISTS "academy"."course_late_policy_events" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- No foreign key: the history of who set what outlives a removed course.
  "course_id"          uuid NOT NULL,
  "revision"           integer NOT NULL,
  "grace_hours"        numeric(8, 2),
  "deduction_per_day"  numeric(5, 4),
  "reason"             text NOT NULL,
  "actor_id"           uuid NOT NULL,
  "at"                 timestamptz NOT NULL,
  CONSTRAINT "course_late_policy_events_uq" UNIQUE ("course_id", "revision")
);
