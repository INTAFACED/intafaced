-- svc-quant · compute tiers on quota profiles (RC-algo-dev-05, an extension of AL-limits-01)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. A tier is published on one quota profile: its limits are that profile's, plus
-- two owner values, how fresh the data a run reads is (whole seconds behind the exchange's own prices) and its
-- execution priority class. A NULL value is blank ("not set"). A withdrawn tier keeps its row with published false.
-- Every operator write keeps its audit row in quota_audit, keyed, with its actor and reason.

CREATE TABLE IF NOT EXISTS "quant"."compute_tiers" (
  "profile" text PRIMARY KEY CHECK (char_length("profile") BETWEEN 1 AND 80),
  "data_freshness_seconds" numeric(18, 0) CHECK ("data_freshness_seconds" IS NULL OR "data_freshness_seconds" >= 0),
  "priority_class" numeric(18, 0) CHECK ("priority_class" IS NULL OR "priority_class" >= 0),
  "published" boolean NOT NULL,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL
);

ALTER TABLE "quant"."quota_audit" DROP CONSTRAINT IF EXISTS "quota_audit_action_check";
ALTER TABLE "quant"."quota_audit" ADD CONSTRAINT "quota_audit_action_check" CHECK ("action" IN ('set', 'assign', 'tier'));
