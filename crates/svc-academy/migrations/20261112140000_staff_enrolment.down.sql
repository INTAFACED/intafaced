-- intafaced:destructive — reversal of 20261112140000_staff_enrolment.sql
-- Drops the staff enrolment audit, bulk uploads, course invitations, course email opt-outs and history, and learner
-- exports. Enrolments themselves are kept.
DROP TABLE IF EXISTS "academy"."report_tasks";
DROP TABLE IF EXISTS "academy"."bulk_email_recipients";
DROP TABLE IF EXISTS "academy"."bulk_emails";
DROP TABLE IF EXISTS "academy"."course_email_optouts";
DROP TABLE IF EXISTS "academy"."course_invitations";
DROP TABLE IF EXISTS "academy"."bulk_enrol_uploads";
DROP TABLE IF EXISTS "academy"."staff_enrolment_events";
