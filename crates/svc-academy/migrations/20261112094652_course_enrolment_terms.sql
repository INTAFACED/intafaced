-- svc-academy · a course's seat cap, enrolment window and visibility (AC-enrolment-01, AC-catalogue-03; J-academy-02 #1)
-- Reversal: 20261112094652_course_enrolment_terms.down.sql
--
-- One row per course (a curriculum path until courses are rows), set by staff with a reason; the row keeps who set it
-- last and why. No row means no cap, no window and published: nothing is given a cap, a window or a visibility it was
-- not set. A cap counts the course's active enrolments; a full course, a window not started or ended, and a hidden or
-- unpublished course close enrolment with that reason. Enrolments already made are kept.

CREATE TABLE IF NOT EXISTS "academy"."course_enrolment_terms" (
  "path"        text PRIMARY KEY,
  "seat_cap"    integer,
  "opens_at"    timestamptz,
  "closes_at"   timestamptz,
  "visibility"  text NOT NULL DEFAULT 'published',
  "reason"      text NOT NULL,
  "set_by"      uuid NOT NULL,
  "set_at"      timestamptz NOT NULL,
  CONSTRAINT "course_enrolment_terms_reason_chk" CHECK (char_length(btrim("reason")) > 0),
  CONSTRAINT "course_enrolment_terms_seat_cap_chk" CHECK ("seat_cap" IS NULL OR "seat_cap" > 0),
  CONSTRAINT "course_enrolment_terms_window_chk" CHECK ("opens_at" IS NULL OR "closes_at" IS NULL OR "opens_at" < "closes_at"),
  CONSTRAINT "course_enrolment_terms_visibility_chk" CHECK ("visibility" IN ('published', 'hidden', 'unpublished'))
);
