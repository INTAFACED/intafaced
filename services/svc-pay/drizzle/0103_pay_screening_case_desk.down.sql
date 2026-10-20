-- intafaced:destructive — reversal of 0103_pay_screening_case_desk.sql
--
-- Drops the desk columns and the decision history. A decision on a case is lost,
-- so this is for CI proof of reversibility and for a database that never held a
-- real decision. The case rows of 0062 stay.

DROP TRIGGER IF EXISTS "screening_case_events_append_only_trg" ON "pay"."screening_case_events";
DROP FUNCTION IF EXISTS "pay"."screening_case_events_append_only"();
DROP INDEX IF EXISTS "pay"."screening_case_events_case_idx";
DROP TABLE IF EXISTS "pay"."screening_case_events";
DROP INDEX IF EXISTS "pay"."screening_cases_spent_for_uq";
DROP INDEX IF EXISTS "pay"."screening_cases_grant_idx";
DROP INDEX IF EXISTS "pay"."screening_cases_desk_idx";
ALTER TABLE "pay"."screening_cases" DROP CONSTRAINT IF EXISTS "screening_cases_upheld_no_grant_ck";
ALTER TABLE "pay"."screening_cases" DROP CONSTRAINT IF EXISTS "screening_cases_release_ck";
ALTER TABLE "pay"."screening_cases" DROP CONSTRAINT IF EXISTS "screening_cases_decision_ck";
ALTER TABLE "pay"."screening_cases" DROP CONSTRAINT IF EXISTS "screening_cases_amount_ck";
ALTER TABLE "pay"."screening_cases"
  DROP COLUMN IF EXISTS "release_spent_for",
  DROP COLUMN IF EXISTS "release_consumed_at",
  DROP COLUMN IF EXISTS "release_expires_at",
  DROP COLUMN IF EXISTS "decided_at",
  DROP COLUMN IF EXISTS "decision_reason",
  DROP COLUMN IF EXISTS "approver_id",
  DROP COLUMN IF EXISTS "decided_by",
  DROP COLUMN IF EXISTS "decision",
  DROP COLUMN IF EXISTS "provider",
  DROP COLUMN IF EXISTS "asset_id",
  DROP COLUMN IF EXISTS "amount",
  DROP COLUMN IF EXISTS "party_ref";
