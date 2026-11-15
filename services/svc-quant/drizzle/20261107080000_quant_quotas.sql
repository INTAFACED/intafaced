-- svc-quant · quotas by plan (AL-limits-01)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. A quota profile is a name with one limit per resource; a NULL limit is blank
-- ("not set") and refuses quant.quota_unset. An account is attached to a profile by an operator; without one, the
-- owner's default profile (QUANT_DEFAULT_QUOTA_PROFILE) applies. Every operator write keeps its audit row, keyed, with
-- its actor and reason.

CREATE TABLE IF NOT EXISTS "quant"."quota_limits" (
  "profile" text NOT NULL CHECK (char_length("profile") BETWEEN 1 AND 80),
  "resource" text NOT NULL,
  "limit_value" numeric(18, 0) CHECK ("limit_value" IS NULL OR "limit_value" >= 0),
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL,
  PRIMARY KEY ("profile", "resource")
);

CREATE TABLE IF NOT EXISTS "quant"."quota_assignments" (
  "account_id" uuid PRIMARY KEY,
  "profile" text NOT NULL CHECK (char_length("profile") BETWEEN 1 AND 80),
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "assigned_by" text NOT NULL,
  "assigned_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "quant"."quota_audit" (
  "idempotency_key" text PRIMARY KEY,
  "action" text NOT NULL CHECK ("action" IN ('set', 'assign')),
  "request" jsonb NOT NULL,
  "response" jsonb NOT NULL,
  "reason" text NOT NULL,
  "actor" text NOT NULL,
  "at" timestamptz NOT NULL
);

-- The counts read by account: a user's runs, and whether each is still running.
CREATE INDEX IF NOT EXISTS "runs_user_finished_idx" ON "quant"."runs" ("user_id", "finished_at");
