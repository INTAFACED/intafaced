-- svc-academy · assignments on course items and the work learners hand in (AC-assignments-01)
-- Reversal: 20261024071500_course_assignments.down.sql
--
-- An outline item of kind `assignment` gets its brief here: instructions, points
-- as a decimal, an optional due date and whether a text answer and a file are
-- off, optional or required. Each save is the next revision. Withdrawing sets
-- withdrawn_at: the row and every hand-in stay. A learner's files are stored in
-- our own object store; this table keeps what was checked. A hand-in is version n
-- of one learner's work, keyed `submit:<item>:<account>:<n>`; late is worked out
-- on read against the due date, never stored. Hand-ins keep their item: an item
-- with hand-ins cannot leave the outline. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."course_assignments" (
  "item_id"         uuid PRIMARY KEY REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "revision"        integer NOT NULL,
  "instructions"    text NOT NULL,
  "points"          numeric(8, 2) NOT NULL,
  "due_at"          timestamptz,
  "text_mode"       text NOT NULL,
  "file_mode"       text NOT NULL,
  "saved_by"        uuid NOT NULL,
  "saved_at"        timestamptz NOT NULL,
  "withdrawn_at"    timestamptz,
  "withdrawn_by"    uuid,
  "withdraw_reason" text,
  CONSTRAINT "course_assignments_revision_chk" CHECK ("revision" > 0),
  CONSTRAINT "course_assignments_points_chk" CHECK ("points" > 0),
  CONSTRAINT "course_assignments_modes_chk" CHECK (
    "text_mode" IN ('off', 'optional', 'required') AND "file_mode" IN ('off', 'optional', 'required')
    AND NOT ("text_mode" = 'off' AND "file_mode" = 'off')
  ),
  CONSTRAINT "course_assignments_withdrawn_chk" CHECK (("withdrawn_at" IS NULL) = ("withdraw_reason" IS NULL))
);

CREATE TABLE IF NOT EXISTS "academy"."assignment_files" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"       uuid NOT NULL REFERENCES "academy"."course_items" ("id") ON DELETE CASCADE,
  "user_id"       uuid NOT NULL,
  "sha256"        text NOT NULL,
  "file_name"     text NOT NULL,
  "content_type"  text NOT NULL,
  "bytes"         bigint NOT NULL,
  "object_key"    text NOT NULL,
  "created_at"    timestamptz NOT NULL,
  CONSTRAINT "assignment_files_key_uq" UNIQUE ("item_id", "user_id", "sha256"),
  CONSTRAINT "assignment_files_sha_chk" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "assignment_files_bytes_chk" CHECK ("bytes" > 0)
);

CREATE TABLE IF NOT EXISTS "academy"."assignment_submissions" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "item_id"       uuid NOT NULL REFERENCES "academy"."course_items" ("id"),
  "user_id"       uuid NOT NULL,
  "version"       integer NOT NULL,
  "state"         text NOT NULL,
  "text"          text,
  "file_id"       uuid REFERENCES "academy"."assignment_files" ("id"),
  "submitted_at"  timestamptz NOT NULL,
  CONSTRAINT "assignment_submissions_key_uq" UNIQUE ("item_id", "user_id", "version"),
  CONSTRAINT "assignment_submissions_version_chk" CHECK ("version" > 0),
  CONSTRAINT "assignment_submissions_state_chk" CHECK (
    "state" IN ('draft', 'submitted', 'pending_review', 'graded', 'returned', 'withdrawn')
  ),
  CONSTRAINT "assignment_submissions_answer_chk" CHECK ("text" IS NOT NULL OR "file_id" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "assignment_submissions_user_idx" ON "academy"."assignment_submissions" ("user_id", "item_id");
