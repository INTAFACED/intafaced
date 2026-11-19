-- svc-academy · residency cohort catalogue (no invented rows)
-- Reversal: 0009_residency_cohorts.down.sql
--
-- Capacity, dates and entry rules are nullable. An unset capacity stays null.
-- This migration inserts nothing.

CREATE TABLE IF NOT EXISTS "academy"."residency_cohorts" (
  "slug"         text PRIMARY KEY,
  "status"       text NOT NULL,
  "published"    boolean NOT NULL,
  "starts_at"    timestamptz,
  "ends_at"      timestamptz,
  "capacity"     integer,
  "entry_rules"  text
);

ALTER TABLE "academy"."residency_cohorts" DROP CONSTRAINT IF EXISTS "residency_cohorts_status_ck";
ALTER TABLE "academy"."residency_cohorts" ADD CONSTRAINT "residency_cohorts_status_ck"
  CHECK ("status" IN ('open', 'closed'));

ALTER TABLE "academy"."residency_cohorts" DROP CONSTRAINT IF EXISTS "residency_cohorts_capacity_ck";
ALTER TABLE "academy"."residency_cohorts" ADD CONSTRAINT "residency_cohorts_capacity_ck"
  CHECK ("capacity" IS NULL OR "capacity" >= 0);
