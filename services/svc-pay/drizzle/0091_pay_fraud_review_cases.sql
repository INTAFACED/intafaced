-- Fraud review cases and their decisions.
-- Reversal: 0091_pay_fraud_review_cases.down.sql
--
-- intafaced:destructive — BEFORE TRUNCATE is the trigger event, and DROP TRIGGER
-- IF EXISTS only makes the trigger create re-runnable. This migration does not
-- TRUNCATE, UPDATE, or DELETE stored rows.
--
-- A held or flagged payment keeps a case across process restart. The case row
-- is the current status. pay.fraud_review_decisions is the append-only record
-- of enqueue, claim, allow, and decline. One source and payment_ref has one case.

CREATE TABLE IF NOT EXISTS "pay"."fraud_review_cases" (
  "id" text PRIMARY KEY,
  "merchant_id" text NOT NULL,
  "payment_ref" text,
  "amount" numeric(38, 18) NOT NULL,
  "asset_id" text NOT NULL,
  "status" text NOT NULL,
  "reason" text NOT NULL,
  "reasons" jsonb NOT NULL,
  "source" text NOT NULL,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL,
  "claimed_by" text,
  "claimed_at" timestamptz,
  "decided_by" text,
  "decided_at" timestamptz,
  "resolution_note" text,
  CONSTRAINT "fraud_review_cases_status_ck"
    CHECK ("status" IN ('open', 'claimed', 'allowed', 'declined')),
  CONSTRAINT "fraud_review_cases_source_ck"
    CHECK ("source" IN ('screening.review', 'control.captured_over_cap', 'fraud.review')),
  CONSTRAINT "fraud_review_cases_amount_ck" CHECK ("amount" > 0),
  CONSTRAINT "fraud_review_cases_asset_ck" CHECK (length(btrim("asset_id")) > 0),
  CONSTRAINT "fraud_review_cases_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "fraud_review_cases_created_by_ck" CHECK (length(btrim("created_by")) > 0),
  CONSTRAINT "fraud_review_cases_reasons_ck" CHECK (jsonb_typeof("reasons") = 'array'),
  CONSTRAINT "fraud_review_cases_payment_ref_ck"
    CHECK ("payment_ref" IS NULL OR length(btrim("payment_ref")) > 0),
  CONSTRAINT "fraud_review_cases_decided_ck"
    CHECK (
      ("status" IN ('open', 'claimed') AND "decided_by" IS NULL AND "decided_at" IS NULL)
      OR ("status" IN ('allowed', 'declined') AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS "fraud_review_cases_source_payment_ref_uidx"
  ON "pay"."fraud_review_cases" ("source", "payment_ref")
  WHERE "payment_ref" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "fraud_review_cases_open_idx"
  ON "pay"."fraud_review_cases" ("created_at", "id")
  WHERE "status" IN ('open', 'claimed');

CREATE TABLE IF NOT EXISTS "pay"."fraud_review_decisions" (
  "decision_id" bigserial PRIMARY KEY,
  "case_id" text NOT NULL REFERENCES "pay"."fraud_review_cases" ("id"),
  "effect" text NOT NULL,
  "actor_id" text NOT NULL,
  "note" text,
  "decided_at" timestamptz NOT NULL,
  CONSTRAINT "fraud_review_decisions_effect_ck"
    CHECK ("effect" IN ('enqueue', 'claim', 'allow', 'decline')),
  CONSTRAINT "fraud_review_decisions_actor_ck" CHECK (length(btrim("actor_id")) > 0)
);

CREATE INDEX IF NOT EXISTS "fraud_review_decisions_case_idx"
  ON "pay"."fraud_review_decisions" ("case_id", "decision_id");

CREATE OR REPLACE FUNCTION "pay"."fraud_review_decisions_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "fraud_review_decisions_append_only_trg" ON "pay"."fraud_review_decisions";
CREATE TRIGGER "fraud_review_decisions_append_only_trg"
  BEFORE UPDATE OR DELETE ON "pay"."fraud_review_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."fraud_review_decisions_append_only"();

DROP TRIGGER IF EXISTS "fraud_review_decisions_append_only_truncate_trg" ON "pay"."fraud_review_decisions";
CREATE TRIGGER "fraud_review_decisions_append_only_truncate_trg"
  BEFORE TRUNCATE ON "pay"."fraud_review_decisions"
  FOR EACH STATEMENT EXECUTE FUNCTION "pay"."fraud_review_decisions_append_only"();
