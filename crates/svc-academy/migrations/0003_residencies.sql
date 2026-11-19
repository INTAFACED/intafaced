-- svc-academy · residency applications Stage-1 (NO PAY)
-- Reversal: 0003_residencies.down.sql
--
-- Stage-1 is apply / withdraw / operator accept|reject. IFC pay and revenue
-- share are Class M and deliberately absent — no balance-shaped columns.

DO $$ BEGIN
  CREATE TYPE "academy"."residency_status" AS ENUM ('applied', 'accepted', 'rejected', 'withdrawn');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "academy"."residency_applications" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"        uuid NOT NULL,
  "cohort_slug"    text NOT NULL,
  "statement"      text NOT NULL,
  "status"         "academy"."residency_status" NOT NULL DEFAULT 'applied',
  "applied_at"     timestamptz NOT NULL DEFAULT now(),
  "decided_at"     timestamptz,
  "decided_by"     uuid,
  "decision_note"  text,
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

-- One open application per user+cohort (withdraw/reject frees the slot).
CREATE UNIQUE INDEX IF NOT EXISTS "residency_open_user_cohort_idx"
  ON "academy"."residency_applications" ("user_id", "cohort_slug")
  WHERE "status" = 'applied';

CREATE INDEX IF NOT EXISTS "residency_user_idx"
  ON "academy"."residency_applications" ("user_id", "applied_at" DESC);

CREATE INDEX IF NOT EXISTS "residency_status_cohort_idx"
  ON "academy"."residency_applications" ("status", "cohort_slug", "applied_at" DESC);

ALTER TABLE "academy"."residency_applications" DROP CONSTRAINT IF EXISTS "residency_statement_len_ck";
ALTER TABLE "academy"."residency_applications" ADD CONSTRAINT "residency_statement_len_ck"
  CHECK (char_length(trim("statement")) >= 20 AND char_length("statement") <= 2000);

ALTER TABLE "academy"."residency_applications" DROP CONSTRAINT IF EXISTS "residency_decision_shape_ck";
ALTER TABLE "academy"."residency_applications" ADD CONSTRAINT "residency_decision_shape_ck" CHECK (
  ("status" = 'applied' AND "decided_at" IS NULL AND "decided_by" IS NULL)
  OR
  ("status" <> 'applied' AND "decided_at" IS NOT NULL AND "decided_by" IS NOT NULL)
);
