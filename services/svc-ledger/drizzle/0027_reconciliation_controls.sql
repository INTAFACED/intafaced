-- svc-ledger · operator reconciliation controls (OPS-reconciliation-01)
-- Reversal: 0027_reconciliation_controls.down.sql
--
-- Beside the three built-in proofs. Operator rows are draft until a tolerance,
-- schedule and severity are stored. The three built-in rows cannot be deleted.
-- A run row is inserted before balances are read. Audit is append-only.

CREATE TABLE "ledger"."reconciliation_controls" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "builtin" boolean DEFAULT false NOT NULL,
  "builtin_key" text,
  "template" text NOT NULL,
  "check_kind" text,
  "state" text DEFAULT 'draft' NOT NULL,
  "explanation" text DEFAULT '' NOT NULL,
  "labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "schedule" jsonb,
  "severity" text,
  "period" text,
  "tolerance" jsonb,
  "margin" text,
  "account_set" jsonb NOT NULL,
  "threshold" jsonb,
  "version" integer DEFAULT 1 NOT NULL,
  "defined_by" text NOT NULL,
  "defined_reason" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "reconciliation_controls_template_ck" CHECK ("template" IN ('ledger_invariant', 'outside_balance', 'threshold', 'source_parity')),
  CONSTRAINT "reconciliation_controls_state_ck" CHECK ("state" IN ('draft', 'active')),
  CONSTRAINT "reconciliation_controls_check_kind_ck" CHECK ("check_kind" IS NULL OR "check_kind" IN ('replay', 'chain', 'netting', 'replay_and_netting')),
  CONSTRAINT "reconciliation_controls_severity_ck" CHECK ("severity" IS NULL OR "severity" IN ('info', 'warning', 'critical')),
  CONSTRAINT "reconciliation_controls_period_ck" CHECK ("period" IS NULL OR "period" IN ('hour', 'day', 'iso_week', 'month')),
  CONSTRAINT "reconciliation_controls_builtin_key_ck" CHECK ("builtin" = false OR "builtin_key" IS NOT NULL),
  CONSTRAINT "reconciliation_controls_builtin_active_ck" CHECK ("builtin" = false OR "state" = 'active'),
  CONSTRAINT "reconciliation_controls_explanation_ck" CHECK (length("explanation") <= 2000),
  CONSTRAINT "reconciliation_controls_labels_ck" CHECK (jsonb_typeof("labels") = 'array'),
  CONSTRAINT "reconciliation_controls_account_set_ck" CHECK (jsonb_typeof("account_set") = 'object'),
  CONSTRAINT "reconciliation_controls_tolerance_ck" CHECK ("tolerance" IS NULL OR jsonb_typeof("tolerance") = 'object'),
  CONSTRAINT "reconciliation_controls_schedule_ck" CHECK ("schedule" IS NULL OR jsonb_typeof("schedule") = 'object'),
  CONSTRAINT "reconciliation_controls_threshold_ck" CHECK ("threshold" IS NULL OR jsonb_typeof("threshold") = 'object'),
  CONSTRAINT "reconciliation_controls_margin_ck" CHECK ("margin" IS NULL OR "margin" ~ '^[0-9]+([.][0-9]{1,18})?$'),
  CONSTRAINT "reconciliation_controls_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "reconciliation_controls_defined_by_ck" CHECK (length("defined_by") > 0),
  CONSTRAINT "reconciliation_controls_defined_reason_ck" CHECK (length("defined_reason") >= 12)
);

CREATE UNIQUE INDEX "reconciliation_controls_builtin_key_uq"
  ON "ledger"."reconciliation_controls" ("builtin_key")
  WHERE "builtin_key" IS NOT NULL;

CREATE TABLE "ledger"."reconciliation_control_audit" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "control_id" uuid NOT NULL,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL,
  "action" text NOT NULL,
  "request_id" text,
  "detail" jsonb NOT NULL,
  "recorded_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "reconciliation_control_audit_control_id_fkey" FOREIGN KEY ("control_id") REFERENCES "ledger"."reconciliation_controls" ("id"),
  CONSTRAINT "reconciliation_control_audit_actor_ck" CHECK (length("actor_id") > 0),
  CONSTRAINT "reconciliation_control_audit_reason_ck" CHECK (length("reason") > 0),
  CONSTRAINT "reconciliation_control_audit_action_ck" CHECK ("action" IN ('define', 'update', 'run')),
  CONSTRAINT "reconciliation_control_audit_detail_ck" CHECK (jsonb_typeof("detail") = 'object')
);

CREATE INDEX "reconciliation_control_audit_control_idx"
  ON "ledger"."reconciliation_control_audit" ("control_id", "recorded_at");

CREATE TABLE "ledger"."reconciliation_control_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "control_id" uuid NOT NULL,
  "operation_id" text,
  "fingerprint" text NOT NULL,
  "status" text NOT NULL,
  "phase" text DEFAULT '' NOT NULL,
  "error_code" text DEFAULT '' NOT NULL,
  "as_of" timestamp with time zone NOT NULL,
  "read_at" timestamp with time zone NOT NULL,
  "margin" text NOT NULL,
  "sources" jsonb NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "outside_side" text NOT NULL,
  "period_start" timestamp with time zone NOT NULL,
  "period_end" timestamp with time zone NOT NULL,
  "actor_id" text NOT NULL,
  "reason" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "finished_at" timestamp with time zone,
  CONSTRAINT "reconciliation_control_runs_control_id_fkey" FOREIGN KEY ("control_id") REFERENCES "ledger"."reconciliation_controls" ("id"),
  CONSTRAINT "reconciliation_control_runs_status_ck" CHECK ("status" IN ('started', 'PASS', 'FAIL', 'ERROR', 'UNSET')),
  CONSTRAINT "reconciliation_control_runs_margin_ck" CHECK ("margin" = 'unset' OR "margin" ~ '^[0-9]+([.][0-9]{1,18})?$'),
  CONSTRAINT "reconciliation_control_runs_outside_ck" CHECK ("outside_side" IN ('unset', 'snapshot', 'unavailable', 'not_applicable')),
  CONSTRAINT "reconciliation_control_runs_sources_ck" CHECK (jsonb_typeof("sources") = 'object'),
  CONSTRAINT "reconciliation_control_runs_evidence_ck" CHECK (jsonb_typeof("evidence") = 'object'),
  CONSTRAINT "reconciliation_control_runs_actor_ck" CHECK (length("actor_id") > 0),
  CONSTRAINT "reconciliation_control_runs_reason_ck" CHECK (length("reason") >= 12),
  CONSTRAINT "reconciliation_control_runs_fingerprint_ck" CHECK (length("fingerprint") > 0)
);

CREATE UNIQUE INDEX "reconciliation_control_runs_operation_uq"
  ON "ledger"."reconciliation_control_runs" ("operation_id")
  WHERE "operation_id" IS NOT NULL;

CREATE INDEX "reconciliation_control_runs_control_idx"
  ON "ledger"."reconciliation_control_runs" ("control_id", "period_start");

CREATE OR REPLACE FUNCTION "ledger"."reconciliation_controls_no_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reconciliation controls cannot be removed'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.builtin AND NEW.builtin_key IS DISTINCT FROM OLD.builtin_key THEN
    RAISE EXCEPTION 'built-in reconciliation controls cannot be removed'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'reconciliation controls cannot be removed'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "reconciliation_controls_no_delete"
  BEFORE DELETE OR UPDATE ON "ledger"."reconciliation_controls"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."reconciliation_controls_no_delete"();

CREATE TRIGGER "reconciliation_controls_no_truncate"
  BEFORE TRUNCATE ON "ledger"."reconciliation_controls"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."reconciliation_controls_no_delete"();

CREATE OR REPLACE FUNCTION "ledger"."reconciliation_control_audit_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation_control_audit is append-only: % refused', TG_OP
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "reconciliation_control_audit_append_only"
  BEFORE UPDATE OR DELETE ON "ledger"."reconciliation_control_audit"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."reconciliation_control_audit_append_only"();

CREATE TRIGGER "reconciliation_control_audit_no_truncate"
  BEFORE TRUNCATE ON "ledger"."reconciliation_control_audit"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."reconciliation_control_audit_append_only"();

CREATE OR REPLACE FUNCTION "ledger"."reconciliation_control_runs_no_delete"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'reconciliation control runs cannot be removed'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER "reconciliation_control_runs_no_delete"
  BEFORE DELETE ON "ledger"."reconciliation_control_runs"
  FOR EACH ROW EXECUTE FUNCTION "ledger"."reconciliation_control_runs_no_delete"();

CREATE TRIGGER "reconciliation_control_runs_no_truncate"
  BEFORE TRUNCATE ON "ledger"."reconciliation_control_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION "ledger"."reconciliation_control_runs_no_delete"();

INSERT INTO "ledger"."reconciliation_controls" (
  "id", "builtin", "builtin_key", "template", "check_kind", "state", "explanation", "labels", "schedule", "severity",
  "period", "tolerance", "margin", "account_set", "defined_by", "defined_reason"
) VALUES
  (
    '11111111-1111-4111-8111-111111111111', true, 'replay', 'ledger_invariant', 'replay', 'active',
    'Built-in replay of cached balances. It cannot be removed.', '[]'::jsonb,
    '{"cadence":"hourly","minute":0}'::jsonb, 'critical', 'hour', '{"default":"0","byAsset":{}}'::jsonb, '0',
    '{"mode":"all"}'::jsonb, 'reconciliation', 'built-in ledger invariant'
  ),
  (
    '22222222-2222-4222-8222-222222222222', true, 'chain', 'ledger_invariant', 'chain', 'active',
    'Built-in hash chain. It cannot be removed.', '[]'::jsonb,
    '{"cadence":"hourly","minute":0}'::jsonb, 'critical', 'hour', '{"default":"0","byAsset":{}}'::jsonb, '0',
    '{"mode":"all"}'::jsonb, 'reconciliation', 'built-in ledger invariant'
  ),
  (
    '33333333-3333-4333-8333-333333333333', true, 'netting', 'ledger_invariant', 'netting', 'active',
    'Built-in per-asset netting. It cannot be removed.', '[]'::jsonb,
    '{"cadence":"hourly","minute":0}'::jsonb, 'critical', 'hour', '{"default":"0","byAsset":{}}'::jsonb, '0',
    '{"mode":"all"}'::jsonb, 'reconciliation', 'built-in ledger invariant'
  );
