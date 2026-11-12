-- svc-quant · strategy lifecycle and the promotion gate (AL-lifecycle-01, ENGINE section 9)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. The owner's criteria an operator sets at runtime (the gate's and the
-- out-of-sample verdict's) are one row each, blank (NULL) for "not set", with every write kept in an audit row with its
-- actor and reason. A promotion is one gate decision row and, when approved, one stage row, written in one transaction
-- under the request's derived key: a stage row never exists without its decision.

CREATE TABLE IF NOT EXISTS "quant"."owner_criteria" (
  "name" text PRIMARY KEY,
  "value" text,
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "quant"."owner_criteria_audit" (
  "idempotency_key" text PRIMARY KEY,
  "name" text NOT NULL,
  "value" text,
  -- True: the write removed the operator's row, so the boot value stands again.
  "to_boot" boolean NOT NULL,
  "reason" text NOT NULL,
  "actor" text NOT NULL,
  "at" timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS "quant"."gate_decisions" (
  "idempotency_key" text PRIMARY KEY,
  "account_id" uuid NOT NULL,
  "strategy_id" text NOT NULL,
  "strategy_version" integer NOT NULL CHECK ("strategy_version" >= 1),
  "decision" text NOT NULL CHECK ("decision" IN ('approved', 'rejected')),
  "criteria" jsonb NOT NULL,
  "run_ids" jsonb NOT NULL,
  "response" jsonb NOT NULL,
  "actor" text NOT NULL,
  "at" timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS "gate_decisions_version_idx" ON "quant"."gate_decisions" ("account_id", "strategy_id", "strategy_version", "at");

CREATE TABLE IF NOT EXISTS "quant"."strategy_stages" (
  "decision_key" text PRIMARY KEY REFERENCES "quant"."gate_decisions"("idempotency_key"),
  "account_id" uuid NOT NULL,
  "strategy_id" text NOT NULL,
  "strategy_version" integer NOT NULL CHECK ("strategy_version" >= 1),
  "from_stage" text NOT NULL,
  "to_stage" text NOT NULL,
  "run_ids" jsonb NOT NULL,
  "at" timestamptz NOT NULL
);

-- One move into a stage per version: pressing Promote twice never moves the stage twice.
CREATE UNIQUE INDEX IF NOT EXISTS "strategy_stages_once_idx" ON "quant"."strategy_stages" ("account_id", "strategy_id", "strategy_version", "to_stage");
