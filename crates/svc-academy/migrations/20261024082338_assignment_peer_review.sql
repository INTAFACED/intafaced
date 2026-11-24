-- svc-academy · rubrics and peer or self review on an assignment (AC-assignments-03)
-- Reversal: 20261024082338_assignment_peer_review.down.sql
--
-- A rubric is a list of criteria, each with its levels as decimal strings. A rubric row is never changed: saving the
-- review steps with other criteria writes a new rubric, so a review keeps the criteria it was scored against. The
-- review steps of an assignment (peer review and how many reviews each learner gives, self review) are saved over the
-- revision read. A review is one row per reviewer and author, keyed `peer:<assignment>:<reviewer>:<author>`: written
-- when the work is handed to the reviewer (marks null) and completed once with the marks; a self review has the
-- learner as both. The reviewer never learns who the author is. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."assignment_rubrics" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "course_id"   uuid NOT NULL REFERENCES "academy"."courses" ("id") ON DELETE CASCADE,
  "criteria"    jsonb NOT NULL,
  "created_by"  uuid NOT NULL,
  "created_at"  timestamptz NOT NULL,
  CONSTRAINT "assignment_rubrics_criteria_chk" CHECK (jsonb_typeof("criteria") = 'array' AND jsonb_array_length("criteria") > 0)
);

CREATE TABLE IF NOT EXISTS "academy"."assignment_review_steps" (
  "item_id"     uuid PRIMARY KEY REFERENCES "academy"."course_assignments" ("item_id") ON DELETE CASCADE,
  "revision"    integer NOT NULL,
  "peer"        boolean NOT NULL,
  "peer_count"  integer,
  "self"        boolean NOT NULL,
  "rubric_id"   uuid REFERENCES "academy"."assignment_rubrics" ("id"),
  "saved_by"    uuid NOT NULL,
  "saved_at"    timestamptz NOT NULL,
  CONSTRAINT "assignment_review_steps_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "assignment_review_steps_count_chk" CHECK ("peer_count" IS NULL OR "peer_count" BETWEEN 1 AND 20),
  CONSTRAINT "assignment_review_steps_rubric_chk" CHECK (NOT ("peer" OR "self") OR "rubric_id" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "academy"."assignment_reviews" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"         uuid NOT NULL REFERENCES "academy"."course_items" ("id"),
  "reviewer_id"     uuid NOT NULL,
  "author_id"       uuid NOT NULL,
  "version"         integer NOT NULL,
  "rubric_id"       uuid NOT NULL REFERENCES "academy"."assignment_rubrics" ("id"),
  "marks"           jsonb,
  "total"           numeric(10, 2),
  "allocated_at"    timestamptz NOT NULL,
  "reviewed_at"     timestamptz,
  CONSTRAINT "assignment_reviews_key_uq" UNIQUE ("item_id", "reviewer_id", "author_id"),
  CONSTRAINT "assignment_reviews_submission_fk" FOREIGN KEY ("item_id", "author_id", "version")
    REFERENCES "academy"."assignment_submissions" ("item_id", "user_id", "version"),
  CONSTRAINT "assignment_reviews_done_chk" CHECK (("marks" IS NULL) = ("reviewed_at" IS NULL) AND ("marks" IS NULL) = ("total" IS NULL))
);
CREATE INDEX IF NOT EXISTS "assignment_reviews_author_idx" ON "academy"."assignment_reviews" ("item_id", "author_id");
