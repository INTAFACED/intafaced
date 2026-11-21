-- intafaced:destructive — reversal of 20261112094652_course_enrolment_terms.sql
-- Drops every seat cap, enrolment window and visibility staff set; courses open again with no cap. Enrolments are kept.
DROP TABLE IF EXISTS "academy"."course_enrolment_terms";
