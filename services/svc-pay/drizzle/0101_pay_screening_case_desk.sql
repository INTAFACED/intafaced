-- svc-pay · W-compliance-notices-02 screening cases a compliance desk can read and decide.
-- Reversal: 0101_pay_screening_case_desk.down.sql
--
-- Adds, to the case row of 0062, what a person needs to read it: who the send was
-- for (an id, never a name or address), how much of what asset, which provider
-- answered, and what a compliance decision said. The row still stores no party
-- name, registration number, wallet address or list contents.
--
-- RELEASE IS ONE USE, BOUNDED, AND NEVER A SANCTIONS HIT. A released case lets the
-- same party send up to the case amount of the same asset ONCE before
-- `release_expires_at` (the owner-set time-to-live; no default). The original
-- send stays refused: a release never edits `status`, the guard spends it on a
-- NEW withdrawal key. A `refuse` case can only be upheld (CHECK below).

ALTER TABLE "pay"."screening_cases"
  ADD COLUMN IF NOT EXISTS "party_ref"             text,
  ADD COLUMN IF NOT EXISTS "amount"                text,
  ADD COLUMN IF NOT EXISTS "asset_id"              text,
  ADD COLUMN IF NOT EXISTS "provider"              text,
  ADD COLUMN IF NOT EXISTS "decision"              text,
  ADD COLUMN IF NOT EXISTS "decided_by"            text,
  ADD COLUMN IF NOT EXISTS "approver_id"           text,
  ADD COLUMN IF NOT EXISTS "decision_reason"       text,
  ADD COLUMN IF NOT EXISTS "decided_at"            timestamptz,
  ADD COLUMN IF NOT EXISTS "release_expires_at"    timestamptz,
  ADD COLUMN IF NOT EXISTS "release_consumed_at"   timestamptz;

ALTER TABLE "pay"."screening_cases" DROP CONSTRAINT IF EXISTS "screening_cases_amount_ck";
ALTER TABLE "pay"."screening_cases" ADD CONSTRAINT "screening_cases_amount_ck"
  CHECK ("amount" IS NULL OR "amount" ~ '^[0-9]+(\.[0-9]{1,18})?$');
ALTER TABLE "pay"."screening_cases" DROP CONSTRAINT IF EXISTS "screening_cases_decision_ck";
ALTER TABLE "pay"."screening_cases" ADD CONSTRAINT "screening_cases_decision_ck" CHECK (
  ("decision" IS NULL AND "decided_by" IS NULL AND "decided_at" IS NULL AND "decision_reason" IS NULL
     AND "approver_id" IS NULL AND "release_expires_at" IS NULL AND "release_consumed_at" IS NULL)
  OR ("decision" IN ('released', 'upheld') AND "decided_by" IS NOT NULL AND length(btrim("decided_by")) > 0
     AND "decided_at" IS NOT NULL AND "decision_reason" IS NOT NULL AND length(btrim("decision_reason")) > 0)
);
ALTER TABLE "pay"."screening_cases" DROP CONSTRAINT IF EXISTS "screening_cases_release_ck";
ALTER TABLE "pay"."screening_cases" ADD CONSTRAINT "screening_cases_release_ck" CHECK (
  "decision" IS DISTINCT FROM 'released' OR (
    "status" IN ('review', 'unavailable')
    AND "approver_id" IS NOT NULL AND lower("approver_id") <> lower("decided_by")
    AND "release_expires_at" IS NOT NULL AND "party_ref" IS NOT NULL AND "amount" IS NOT NULL AND "asset_id" IS NOT NULL
  )
);
ALTER TABLE "pay"."screening_cases" DROP CONSTRAINT IF EXISTS "screening_cases_upheld_no_grant_ck";
ALTER TABLE "pay"."screening_cases" ADD CONSTRAINT "screening_cases_upheld_no_grant_ck" CHECK (
  "decision" IS DISTINCT FROM 'upheld' OR ("release_expires_at" IS NULL AND "release_consumed_at" IS NULL)
);

CREATE INDEX IF NOT EXISTS "screening_cases_desk_idx" ON "pay"."screening_cases" ("updated_at" DESC, "subject_key");
CREATE INDEX IF NOT EXISTS "screening_cases_grant_idx" ON "pay"."screening_cases" ("subject_kind", "party_ref", "asset_id")
  WHERE "decision" = 'released' AND "release_consumed_at" IS NULL;

-- Append-only history of what a person did to a case: decide or rescreen.
CREATE TABLE IF NOT EXISTS "pay"."screening_case_events" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "seq"          bigserial NOT NULL,
  "subject_kind" text NOT NULL,
  "subject_key"  text NOT NULL,
  "action"       text NOT NULL,
  "actor_id"     text NOT NULL,
  "approver_id"  text,
  "from_status"  text NOT NULL,
  "to_status"    text NOT NULL,
  "decision"     text,
  "reason"       text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "screening_case_events_action_known" CHECK ("action" IN ('release', 'uphold', 'rescreen', 'release_spent')),
  CONSTRAINT "screening_case_events_key_ck" CHECK ("subject_key" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "screening_case_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0),
  CONSTRAINT "screening_case_events_reason_not_blank" CHECK (length(btrim("reason")) > 0)
);
CREATE INDEX IF NOT EXISTS "screening_case_events_case_idx" ON "pay"."screening_case_events" ("subject_kind", "subject_key", "seq" DESC);

CREATE OR REPLACE FUNCTION "pay"."screening_case_events_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'pay.screening_case_events is append-only: % is not permitted. Record a new event instead.', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS "screening_case_events_append_only_trg" ON "pay"."screening_case_events";
CREATE TRIGGER "screening_case_events_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."screening_case_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."screening_case_events_append_only"();
