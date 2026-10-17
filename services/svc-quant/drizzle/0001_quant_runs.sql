-- svc-quant · paper run records and claims (QUANTDEPTH)
-- Reversal: 0001_quant_runs.down.sql
--
-- Paper only. A run is not a fill, a balance, or a ledger post.
-- A row is inserted when a backtest or sandbox starts. The only later write
-- sets finished_at, outcome_code, and result together, once.
-- Result bodies are capped at 262144 bytes (RUN_RESULT_MAX_BYTES).

CREATE TABLE IF NOT EXISTS "quant"."runs" (
  "id"                 text PRIMARY KEY,
  "user_id"            uuid,
  "scope_key"          text NOT NULL,
  "idempotency_key"    text NOT NULL,
  "kind"               text NOT NULL,
  "strategy_id"        text,
  "strategy_version"   integer,
  "started_at"         timestamptz NOT NULL,
  "finished_at"        timestamptz,
  "outcome_code"       text,
  "result"             jsonb,
  CONSTRAINT "runs_kind_ck" CHECK ("kind" IN ('backtest', 'sandbox')),
  CONSTRAINT "runs_key_len_ck" CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  CONSTRAINT "runs_scope_len_ck" CHECK (char_length("scope_key") BETWEEN 1 AND 128),
  CONSTRAINT "runs_version_ck" CHECK ("strategy_version" IS NULL OR "strategy_version" >= 1),
  CONSTRAINT "runs_finish_ck" CHECK (
    ("finished_at" IS NULL AND "outcome_code" IS NULL)
    OR ("finished_at" IS NOT NULL AND "outcome_code" IS NOT NULL AND char_length("outcome_code") BETWEEN 1 AND 128)
  ),
  CONSTRAINT "runs_result_size_ck" CHECK (
    "result" IS NULL OR octet_length("result"::text) <= 262144
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "runs_scope_key_idx"
  ON "quant"."runs" ("scope_key", "idempotency_key");

CREATE INDEX IF NOT EXISTS "runs_started_idx"
  ON "quant"."runs" ("started_at", "id");

CREATE OR REPLACE FUNCTION "quant"."reject_run_rewrite"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'quant.run_immutable — run % cannot be rewritten', OLD.id;
  END IF;
  IF OLD.finished_at IS NOT NULL OR OLD.outcome_code IS NOT NULL THEN
    RAISE EXCEPTION 'quant.run_immutable — run % cannot be rewritten', OLD.id;
  END IF;
  IF NEW.finished_at IS NULL OR NEW.outcome_code IS NULL THEN
    RAISE EXCEPTION 'quant.run_immutable — run % cannot be rewritten', OLD.id;
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.strategy_id IS DISTINCT FROM OLD.strategy_id
     OR NEW.strategy_version IS DISTINCT FROM OLD.strategy_version
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'quant.run_immutable — run % cannot be rewritten', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "runs_finish_once" ON "quant"."runs";
CREATE TRIGGER "runs_finish_once"
  BEFORE UPDATE OR DELETE ON "quant"."runs"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_run_rewrite"();

CREATE TABLE IF NOT EXISTS "quant"."claims" (
  "id"               text PRIMARY KEY,
  "run_id"           text NOT NULL UNIQUE REFERENCES "quant"."runs"("id"),
  "user_id"          uuid NOT NULL,
  "idempotency_key"  text NOT NULL,
  "pnl"              text NOT NULL,
  "environment"      text NOT NULL,
  "kind"             text NOT NULL,
  "claim_label"      text NOT NULL,
  "live"             boolean NOT NULL,
  "simulated"        boolean NOT NULL,
  "created_at"       timestamptz NOT NULL,
  CONSTRAINT "claims_key_len_ck" CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  CONSTRAINT "claims_pnl_decimal_ck" CHECK ("pnl" ~ '^-?[0-9]+(\.[0-9]{1,18})?$'),
  CONSTRAINT "claims_environment_ck" CHECK ("environment" IN ('paper', 'backtest', 'shadow')),
  CONSTRAINT "claims_kind_ck" CHECK ("kind" IN ('paper', 'simulated')),
  CONSTRAINT "claims_live_ck" CHECK ("live" = false AND "simulated" = true),
  CONSTRAINT "claims_label_ck" CHECK (
    "claim_label" IN (
      'Paper — not live performance',
      'Historical simulation — not a forecast',
      'Shadow — not live performance'
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "claims_user_key_idx"
  ON "quant"."claims" ("user_id", "idempotency_key");

CREATE OR REPLACE FUNCTION "quant"."reject_claim_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.run_immutable — claim % cannot be rewritten', OLD.id;
END;
$$;

DROP TRIGGER IF EXISTS "claims_immutable" ON "quant"."claims";
CREATE TRIGGER "claims_immutable"
  BEFORE UPDATE OR DELETE ON "quant"."claims"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_claim_mutation"();
