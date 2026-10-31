-- svc-quant · quotas by plan (AL-limits-01)
-- Reversal: 20261031045011_quant_quotas.down.sql
--
-- No money, no balance, no ledger post. A quota profile is a name with one limit per resource; an account is attached
-- to a profile. Both are owner values written by an operator with a reason: each row is also the audit row of its
-- write (who, why, when), rows are append-only, and the latest row (highest seq) is the one in force. A blank limit is
-- stored as NULL and refuses by name; 0 is a deliberate value that refuses every create of that resource.

CREATE TABLE IF NOT EXISTS "quant"."quota_limits" (
  "profile"          text NOT NULL,
  "resource"         text NOT NULL,
  "seq"              integer NOT NULL,
  "limit_value"      bigint NULL,
  "reason"           text NOT NULL,
  "set_by"           uuid NOT NULL,
  "idempotency_key"  text NOT NULL,
  "set_at"           timestamptz NOT NULL,
  PRIMARY KEY ("profile", "resource", "seq"),
  CONSTRAINT "quota_limits_profile_ck" CHECK ("profile" ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$'),
  CONSTRAINT "quota_limits_resource_ck" CHECK ("resource" IN (
    'strategies', 'versions_per_strategy', 'concurrent_runs', 'paper_runs', 'stored_runs', 'log_lines',
    'storage_bytes', 'collaborators_per_strategy', 'notifications_per_day'
  )),
  CONSTRAINT "quota_limits_seq_ck" CHECK ("seq" >= 1),
  CONSTRAINT "quota_limits_value_ck" CHECK ("limit_value" IS NULL OR "limit_value" >= 0),
  CONSTRAINT "quota_limits_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "quota_limits_key_len_ck" CHECK (char_length("idempotency_key") BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX IF NOT EXISTS "quota_limits_key_idx" ON "quant"."quota_limits" ("idempotency_key");

CREATE TABLE IF NOT EXISTS "quant"."quota_assignments" (
  "account_id"       uuid NOT NULL,
  "seq"              integer NOT NULL,
  "profile"          text NOT NULL,
  "reason"           text NOT NULL,
  "assigned_by"      uuid NOT NULL,
  "idempotency_key"  text NOT NULL,
  "assigned_at"      timestamptz NOT NULL,
  PRIMARY KEY ("account_id", "seq"),
  CONSTRAINT "quota_assignments_profile_ck" CHECK ("profile" ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$'),
  CONSTRAINT "quota_assignments_seq_ck" CHECK ("seq" >= 1),
  CONSTRAINT "quota_assignments_reason_ck" CHECK (char_length("reason") BETWEEN 1 AND 500),
  CONSTRAINT "quota_assignments_key_len_ck" CHECK (char_length("idempotency_key") BETWEEN 1 AND 128)
);
CREATE UNIQUE INDEX IF NOT EXISTS "quota_assignments_key_idx" ON "quant"."quota_assignments" ("idempotency_key");

-- Concurrent runs are counted from the runs still in flight.
CREATE INDEX IF NOT EXISTS "runs_in_flight_idx" ON "quant"."runs" ("user_id") WHERE "finished_at" IS NULL;

CREATE OR REPLACE FUNCTION "quant"."reject_quota_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.quota_immutable — a quota row is never rewritten; write the next one';
END;
$$;

DROP TRIGGER IF EXISTS "quota_limits_append_only" ON "quant"."quota_limits";
CREATE TRIGGER "quota_limits_append_only"
  BEFORE UPDATE OR DELETE ON "quant"."quota_limits"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_quota_rewrite"();

DROP TRIGGER IF EXISTS "quota_assignments_append_only" ON "quant"."quota_assignments";
CREATE TRIGGER "quota_assignments_append_only"
  BEFORE UPDATE OR DELETE ON "quant"."quota_assignments"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_quota_rewrite"();
