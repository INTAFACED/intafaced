-- svc-academy · staff enrolment, course invitations, course email and learner exports (J-academy-15: AC-enrolment-02,
-- AC-enrolment-03, AC-notifications-02, AC-analytics-02)
-- Reversal: 20261112140000_staff_enrolment.down.sql
--
-- `staff_enrolment_events`: every enrolment staff made, one or in bulk, with who, why, and what it went past (a full
--   course, a closed window, a hidden or unpublished course). Keyed `enrol:<course>:<learner>:<n>`, n the learner's
--   enrolment count on that course, so a replay answers with the stored event.
-- `bulk_enrol_uploads`: one bulk upload and its answer per address, keyed by the course and the upload's addresses, so
--   the same upload again answers the stored rows and changes nothing. No mail is sent for a bulk enrolment.
-- `course_invitations`: an invitation of an address to a course, kept as a one-way hash and a masked form for staff;
--   the mail step needs an email provider, which this build does not have.
-- `course_email_optouts`: a learner's own "no course email" for one course.
-- `bulk_emails` and `bulk_email_recipients`: a course email, written before any send, with each recipient's state.
--   With no email provider every send is refused and no recipient is ever marked sent.
-- `report_tasks`: a learner export: requested, run in the background, and kept with its time and content hash until
--   it expires. No money moves.

CREATE TABLE IF NOT EXISTS "academy"."staff_enrolment_events" (
  "key"        text PRIMARY KEY,
  "path"       text NOT NULL,
  "user_id"    uuid NOT NULL,
  "source"     text NOT NULL,
  "bypassed"   text[] NOT NULL DEFAULT '{}',
  "reason"     text NOT NULL,
  "actor_id"   uuid NOT NULL,
  "at"         timestamptz NOT NULL,
  CONSTRAINT "staff_enrolment_events_source_chk" CHECK ("source" IN ('staff', 'bulk')),
  CONSTRAINT "staff_enrolment_events_reason_chk" CHECK (char_length(btrim("reason")) > 0)
);
CREATE INDEX IF NOT EXISTS "staff_enrolment_events_at_idx" ON "academy"."staff_enrolment_events" ("at" DESC);

CREATE TABLE IF NOT EXISTS "academy"."bulk_enrol_uploads" (
  "key"        text PRIMARY KEY,
  "path"       text NOT NULL,
  "rows"       jsonb NOT NULL,
  "reason"     text NOT NULL,
  "actor_id"   uuid NOT NULL,
  "at"         timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "academy"."course_invitations" (
  "key"           text PRIMARY KEY,
  "path"          text NOT NULL,
  "address_hash"  text NOT NULL,
  "address_mask"  text NOT NULL,
  "reason"        text NOT NULL,
  "invited_by"    uuid NOT NULL,
  "at"            timestamptz NOT NULL,
  CONSTRAINT "course_invitations_reason_chk" CHECK (char_length(btrim("reason")) > 0)
);
CREATE INDEX IF NOT EXISTS "course_invitations_at_idx" ON "academy"."course_invitations" ("at" DESC);

CREATE TABLE IF NOT EXISTS "academy"."course_email_optouts" (
  "user_id"    uuid NOT NULL,
  "path"       text NOT NULL,
  "opted_out"  boolean NOT NULL,
  "at"         timestamptz NOT NULL,
  PRIMARY KEY ("user_id", "path")
);

CREATE TABLE IF NOT EXISTS "academy"."bulk_emails" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"             text NOT NULL,
  "path"            text NOT NULL,
  "subject"         text NOT NULL,
  "body"            text NOT NULL,
  "inactive_days"   integer NOT NULL,
  "state"           text NOT NULL,
  "refusal"         text,
  "actor_id"        uuid NOT NULL,
  "at"              timestamptz NOT NULL,
  CONSTRAINT "bulk_emails_key_uq" UNIQUE ("key"),
  CONSTRAINT "bulk_emails_state_chk" CHECK ("state" IN ('refused', 'sent')),
  CONSTRAINT "bulk_emails_subject_chk" CHECK (char_length(btrim("subject")) > 0)
);
CREATE INDEX IF NOT EXISTS "bulk_emails_at_idx" ON "academy"."bulk_emails" ("at" DESC);

CREATE TABLE IF NOT EXISTS "academy"."bulk_email_recipients" (
  "email_id"   uuid NOT NULL REFERENCES "academy"."bulk_emails" ("id"),
  "user_id"    uuid NOT NULL,
  "state"      text NOT NULL,
  PRIMARY KEY ("email_id", "user_id"),
  CONSTRAINT "bulk_email_recipients_state_chk" CHECK ("state" IN ('not_sent', 'sent', 'skipped_opted_out', 'skipped_inactive'))
);

CREATE TABLE IF NOT EXISTS "academy"."report_tasks" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "key"           text NOT NULL,
  "kind"          text NOT NULL,
  "tag"           text,
  "requested_by"  uuid NOT NULL,
  "state"         text NOT NULL,
  "row_limit"     integer NOT NULL,
  "rows"          integer,
  "content"       text,
  "content_hash"  text,
  "failure"       text,
  "requested_at"  timestamptz NOT NULL,
  "finished_at"   timestamptz,
  "expires_at"    timestamptz,
  "retention_hours" integer NOT NULL,
  CONSTRAINT "report_tasks_key_uq" UNIQUE ("key"),
  CONSTRAINT "report_tasks_kind_chk" CHECK ("kind" IN ('learners')),
  CONSTRAINT "report_tasks_state_chk" CHECK ("state" IN ('queued', 'running', 'done', 'failed'))
);
CREATE INDEX IF NOT EXISTS "report_tasks_requested_idx" ON "academy"."report_tasks" ("requested_at" DESC);
