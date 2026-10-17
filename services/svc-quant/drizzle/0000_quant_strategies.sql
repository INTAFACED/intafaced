-- svc-quant · paper strategy library (QUANTBE)
-- Reversal: 0000_quant_strategies.down.sql
--
-- Paper only. These tables are not a money book: no balance, no hold, no
-- ledger post. Cash and risk figures are decimal strings.
--
-- postgres-init creates schema quant, owned by svc_quant, with no database
-- CREATE grant. CREATE SCHEMA IF NOT EXISTS still checks that privilege and
-- fails with 42501 even when the schema already exists. Create it only when
-- it is missing (a database owner running this file outside the fleet).
--
-- Every save inserts a new strategy_versions row. Older rows are immutable.
-- strategies.deleted_at hides a row from lists and does not remove versions.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'quant') THEN
    CREATE SCHEMA "quant";
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "quant"."strategies" (
  "id"                  text PRIMARY KEY,
  "account_id"          uuid NOT NULL,
  "client_strategy_id"  text NOT NULL,
  "deleted_at"          timestamptz,
  "created_at"          timestamptz NOT NULL,
  CONSTRAINT "strategies_client_id_len_ck" CHECK (char_length("client_strategy_id") BETWEEN 1 AND 128)
);

-- One client id is one strategy for that account. A replay returns this row.
CREATE UNIQUE INDEX IF NOT EXISTS "strategies_account_client_idx"
  ON "quant"."strategies" ("account_id", "client_strategy_id");

CREATE INDEX IF NOT EXISTS "strategies_account_live_idx"
  ON "quant"."strategies" ("account_id", "created_at", "id")
  WHERE "deleted_at" IS NULL;

CREATE TABLE IF NOT EXISTS "quant"."strategy_versions" (
  "strategy_id"   text NOT NULL REFERENCES "quant"."strategies"("id"),
  "version"       integer NOT NULL,
  "name"          text NOT NULL,
  "language"      text NOT NULL,
  "source"        text NOT NULL,
  "cash"          text NOT NULL,
  "blocks"        jsonb NOT NULL,
  "risk"          jsonb NOT NULL,
  "environment"   text NOT NULL,
  "kind"          text NOT NULL,
  "claim_label"   text NOT NULL,
  "live"          boolean NOT NULL,
  "simulated"     boolean NOT NULL,
  "created_at"    timestamptz NOT NULL,
  PRIMARY KEY ("strategy_id", "version"),
  CONSTRAINT "strategy_versions_version_positive_ck" CHECK ("version" >= 1),
  CONSTRAINT "strategy_versions_language_ck" CHECK ("language" = 'javascript'),
  CONSTRAINT "strategy_versions_environment_ck" CHECK ("environment" IN ('paper', 'backtest', 'shadow')),
  CONSTRAINT "strategy_versions_kind_ck" CHECK ("kind" IN ('paper', 'simulated')),
  CONSTRAINT "strategy_versions_live_ck" CHECK ("live" = false AND "simulated" = true),
  CONSTRAINT "strategy_versions_claim_ck" CHECK (
    "claim_label" IN (
      'Paper — not live performance',
      'Historical simulation — not a forecast',
      'Shadow — not live performance'
    )
  ),
  CONSTRAINT "strategy_versions_cash_decimal_ck" CHECK (
    "cash" ~ '^-?[0-9]+(\.[0-9]{1,18})?$'
  ),
  CONSTRAINT "strategy_versions_risk_decimal_ck" CHECK (
    jsonb_typeof("risk") = 'object'
    AND ("risk"->>'maxDrawdown') ~ '^-?[0-9]+(\.[0-9]{1,18})?$'
    AND ("risk"->>'maxNotional') ~ '^-?[0-9]+(\.[0-9]{1,18})?$'
    AND ("risk"->>'kill') ~ '^-?[0-9]+(\.[0-9]{1,18})?$'
  ),
  CONSTRAINT "strategy_versions_blocks_array_ck" CHECK (
    jsonb_typeof("blocks") = 'array' AND jsonb_array_length("blocks") >= 1
  )
);

CREATE OR REPLACE FUNCTION "quant"."reject_strategy_version_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'quant.strategy_version_immutable — version % of strategy % cannot be rewritten', OLD.version, OLD.strategy_id;
END;
$$;

DROP TRIGGER IF EXISTS "strategy_versions_immutable" ON "quant"."strategy_versions";
CREATE TRIGGER "strategy_versions_immutable"
  BEFORE UPDATE OR DELETE ON "quant"."strategy_versions"
  FOR EACH ROW EXECUTE FUNCTION "quant"."reject_strategy_version_mutation"();

-- First result of a write. Replay of the same account + key returns this row.
CREATE TABLE IF NOT EXISTS "quant"."write_receipts" (
  "account_id"       uuid NOT NULL,
  "idempotency_key"  text NOT NULL,
  "operation"        text NOT NULL,
  "response"         jsonb NOT NULL,
  "created_at"       timestamptz NOT NULL,
  PRIMARY KEY ("account_id", "idempotency_key"),
  CONSTRAINT "write_receipts_key_len_ck" CHECK (char_length("idempotency_key") BETWEEN 1 AND 128),
  CONSTRAINT "write_receipts_operation_ck" CHECK ("operation" IN ('create', 'revise', 'delete', 'backtest'))
);

-- The version a backtest ran. Not a fill and not a balance.
CREATE TABLE IF NOT EXISTS "quant"."backtest_runs" (
  "account_id"        uuid NOT NULL,
  "idempotency_key"   text NOT NULL,
  "strategy_id"       text NOT NULL,
  "strategy_version"  integer NOT NULL,
  "symbol"            text NOT NULL,
  "result"            jsonb NOT NULL,
  "created_at"        timestamptz NOT NULL,
  PRIMARY KEY ("account_id", "idempotency_key"),
  CONSTRAINT "backtest_runs_version_positive_ck" CHECK ("strategy_version" >= 1),
  CONSTRAINT "backtest_runs_result_version_ck" CHECK (
    ("result"->>'strategyVersion') ~ '^[0-9]+$'
    AND ("result"->>'strategyVersion')::integer = "strategy_version"
  )
);
