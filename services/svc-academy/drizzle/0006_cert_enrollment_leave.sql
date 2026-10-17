-- svc-academy · path enrolment leave (audit row kept, re-enrol is a new row)
-- Reversal: 0006_cert_enrollment_leave.down.sql
--
-- The Stage-1 primary key (user_id, path_slug) could not keep a left enrolment
-- and a later one. Leave sets left_at. History stays. One active row per
-- account and path.

ALTER TABLE "academy"."cert_enrollments" ADD COLUMN IF NOT EXISTS "id" uuid;
UPDATE "academy"."cert_enrollments" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
ALTER TABLE "academy"."cert_enrollments" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();
ALTER TABLE "academy"."cert_enrollments" ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE "academy"."cert_enrollments" ADD COLUMN IF NOT EXISTS "left_at" timestamptz;
ALTER TABLE "academy"."cert_enrollments" ADD COLUMN IF NOT EXISTS "leave_request_id" text;

ALTER TABLE "academy"."cert_enrollments" DROP CONSTRAINT IF EXISTS "cert_enrollments_pkey";
DROP INDEX IF EXISTS "academy"."cert_enrollments_pk";

ALTER TABLE "academy"."cert_enrollments" ADD PRIMARY KEY ("id");

CREATE UNIQUE INDEX IF NOT EXISTS "cert_enrollments_active_uq"
  ON "academy"."cert_enrollments" ("user_id", "path_slug")
  WHERE "left_at" IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "cert_enrollments_leave_request_uq"
  ON "academy"."cert_enrollments" ("user_id", "leave_request_id")
  WHERE "leave_request_id" IS NOT NULL;
