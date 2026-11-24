-- Reverses 20261112092541_course_purchases.sql. Certificate-track enrolments are ended first, so the old check holds.
DELETE FROM "academy"."course_enrolments" WHERE "track" = 'certificate';
ALTER TABLE "academy"."course_enrolments" DROP CONSTRAINT IF EXISTS "course_enrolments_track_chk";
ALTER TABLE "academy"."course_enrolments" ADD CONSTRAINT "course_enrolments_track_chk" CHECK ("track" IN ('audit'));
DROP TABLE IF EXISTS "academy"."course_purchases";
