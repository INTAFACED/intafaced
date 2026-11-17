-- svc-quant · sandbox limits by plan (AL-limits-02, J-algo-dev-12)
-- Reversal: the matching .down.sql
--
-- No money, no balance, no ledger post. Each quota profile may carry the sandbox limits a run under it meets: the
-- wall-clock time in milliseconds, the bytes of text its variables may hold and the bytes of log it may write. A NULL
-- value is blank ("not set") and refuses every start quant.sandbox_limit_unset. Every operator write keeps its audit row
-- in quota_audit, keyed, with its actor and reason.

CREATE TABLE IF NOT EXISTS "quant"."sandbox_limits" (
  "profile" text NOT NULL CHECK (char_length("profile") BETWEEN 1 AND 80),
  "limit_name" text NOT NULL CHECK ("limit_name" IN ('wall_clock_ms', 'memory_bytes', 'output_bytes')),
  "limit_value" numeric(18, 0) CHECK ("limit_value" IS NULL OR "limit_value" >= 0),
  "reason" text NOT NULL CHECK (char_length("reason") BETWEEN 1 AND 500),
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL,
  PRIMARY KEY ("profile", "limit_name")
);

ALTER TABLE "quant"."quota_audit" DROP CONSTRAINT IF EXISTS "quota_audit_action_check";
ALTER TABLE "quant"."quota_audit" ADD CONSTRAINT "quota_audit_action_check" CHECK ("action" IN ('set', 'assign', 'tier', 'sandbox'));
