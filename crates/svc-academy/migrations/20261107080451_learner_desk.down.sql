-- intafaced:destructive — reversal of 20261107080451_learner_desk.sql
ALTER TABLE "academy"."assessment_attempts" DROP CONSTRAINT IF EXISTS "assessment_attempts_void_chk";
ALTER TABLE "academy"."assessment_attempts" DROP COLUMN IF EXISTS "void_reason";
ALTER TABLE "academy"."assessment_attempts" DROP COLUMN IF EXISTS "voided_by";
ALTER TABLE "academy"."assessment_attempts" DROP COLUMN IF EXISTS "voided_at";
DROP TABLE IF EXISTS "academy"."learner_events";
DROP TABLE IF EXISTS "academy"."learner_tags";
DROP TABLE IF EXISTS "academy"."learner_notes";
DROP TABLE IF EXISTS "academy"."access_grant_events";
DROP TABLE IF EXISTS "academy"."access_grants";
