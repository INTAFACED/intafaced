-- svc-agents · initial schema (§8.2 — agent fleet runtime + model gateway)
-- Reversal: 0000_agents_init.down.sql
--
-- The "agents" schema itself is created by the database bootstrap
-- (tooling/infra/postgres-init/01-service-schemas.sql), which also grants it to
-- the svc_agents role. Migrations run as that role and hold no database-level
-- CREATE privilege, so a migration physically cannot reach outside its own
-- schema (§2).
--
-- Every statement is idempotent: this file is re-runnable, and constraints are
-- re-asserted with DROP ... IF EXISTS first so tightening one later is an edit
-- here rather than a new migration.
--
-- The two properties this file exists to make true regardless of application
-- code are:
--   1. `agent_actions` cannot be rewritten (append-only trigger).
--   2. Usage cannot be added to a settled billing window (seal trigger).
-- Both are enforced in the database because both are the kind of rule that a
-- service bug, a retry, or a future maintainer would otherwise be able to break
-- silently — one destroys an audit trail, the other bills a user twice.

DO $$ BEGIN
  CREATE TYPE "agents"."session_status" AS ENUM ('open', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "agents"."action_kind" AS ENUM (
    'session_open', 'session_close', 'completion', 'embedding', 'tool_call', 'usage_settlement'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "agents"."action_status" AS ENUM ('executed', 'refused', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── agent_definitions ────────────────────────────────────────────────────────
-- What each agent is allowed to do (§8.2 "defined toolset + guardrail schema").

CREATE TABLE IF NOT EXISTS "agents"."agent_definitions" (
  "agent_id"   text PRIMARY KEY,
  "version"    integer NOT NULL DEFAULT 1,
  "guardrail"  jsonb NOT NULL,
  "enabled"    boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_definitions_enabled_idx" ON "agents"."agent_definitions" ("enabled");

-- A version that never moves makes the session snapshot meaningless: two
-- sessions bound to "version 1" could have been bound to different rules.
ALTER TABLE "agents"."agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_version_positive_ck";
ALTER TABLE "agents"."agent_definitions" ADD CONSTRAINT "agent_definitions_version_positive_ck"
  CHECK ("version" >= 1);

-- An empty guardrail is an agent with no declared limits. The parser rejects
-- one; the database refuses to store one, so a hand-written INSERT cannot
-- create an unbounded agent.
ALTER TABLE "agents"."agent_definitions" DROP CONSTRAINT IF EXISTS "agent_definitions_guardrail_shape_ck";
ALTER TABLE "agents"."agent_definitions" ADD CONSTRAINT "agent_definitions_guardrail_shape_ck"
  CHECK (jsonb_typeof("guardrail") = 'object' AND "guardrail" ? 'limits' AND "guardrail" ? 'tools');

-- ── agent_sessions ───────────────────────────────────────────────────────────
-- One run. The guardrail is copied onto the row, not referenced.

CREATE TABLE IF NOT EXISTS "agents"."agent_sessions" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"           text NOT NULL,
  "agent_id"          text NOT NULL,
  "guardrail"         jsonb NOT NULL,
  "guardrail_version" integer NOT NULL,
  "status"            "agents"."session_status" NOT NULL DEFAULT 'open',
  "metered"           boolean NOT NULL DEFAULT true,
  "opened_at"         timestamptz NOT NULL DEFAULT now(),
  "closed_at"         timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "agent_sessions_user_idx" ON "agents"."agent_sessions" ("user_id", "opened_at");
CREATE INDEX IF NOT EXISTS "agent_sessions_status_idx" ON "agents"."agent_sessions" ("status");

-- A closed session with no close time cannot be audited for duration, and an
-- open session with one is a contradiction that a stuck job would produce.
ALTER TABLE "agents"."agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_close_consistent_ck";
ALTER TABLE "agents"."agent_sessions" ADD CONSTRAINT "agent_sessions_close_consistent_ck"
  CHECK (("status" = 'closed') = ("closed_at" IS NOT NULL));

ALTER TABLE "agents"."agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_close_after_open_ck";
ALTER TABLE "agents"."agent_sessions" ADD CONSTRAINT "agent_sessions_close_after_open_ck"
  CHECK ("closed_at" IS NULL OR "closed_at" >= "opened_at");

-- The snapshot must be a real guardrail, for the same reason as above: a
-- session whose limits are `{}` is a session with no limits.
ALTER TABLE "agents"."agent_sessions" DROP CONSTRAINT IF EXISTS "agent_sessions_guardrail_shape_ck";
ALTER TABLE "agents"."agent_sessions" ADD CONSTRAINT "agent_sessions_guardrail_shape_ck"
  CHECK (jsonb_typeof("guardrail") = 'object' AND "guardrail" ? 'limits');

-- ── agent_actions ────────────────────────────────────────────────────────────
-- THE AGENTIC LAW (§8.2): every action lands here, successes and refusals
-- alike, and nothing ever leaves.

CREATE TABLE IF NOT EXISTS "agents"."agent_actions" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"          uuid NOT NULL REFERENCES "agents"."agent_sessions"("id"),
  "user_id"             text NOT NULL,
  "agent_id"            text NOT NULL,
  "sequence"            integer NOT NULL,
  "kind"                "agents"."action_kind" NOT NULL,
  "status"              "agents"."action_status" NOT NULL,
  "tool"                text,
  "task"                text,
  "provider_id"         text,
  "model"               text,
  "input_tokens"        bigint NOT NULL DEFAULT 0,
  "output_tokens"       bigint NOT NULL DEFAULT 0,
  "cost"                numeric(38, 18) NOT NULL DEFAULT 0,
  "refusal_code"        text,
  -- i18n key + params, never rendered prose (§14 DoD 4, Doctrine §0.7).
  "user_message_key"    text NOT NULL,
  "user_message_params" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "input_digest"        text,
  "output_digest"       text,
  "prev_hash"           text,
  "hash"                text NOT NULL,
  "occurred_at"         timestamptz NOT NULL DEFAULT now()
);

-- Ordering within a session, and the constraint that makes a re-ordered or
-- back-dated insert impossible rather than merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS "agent_actions_session_sequence_idx"
  ON "agents"."agent_actions" ("session_id", "sequence");
CREATE INDEX IF NOT EXISTS "agent_actions_user_time_idx" ON "agents"."agent_actions" ("user_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "agent_actions_status_idx" ON "agents"."agent_actions" ("status", "occurred_at");

ALTER TABLE "agents"."agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_sequence_non_negative_ck";
ALTER TABLE "agents"."agent_actions" ADD CONSTRAINT "agent_actions_sequence_non_negative_ck"
  CHECK ("sequence" >= 0);

-- Negative usage would subtract from a bill; negative cost would credit a user
-- for having used the engine.
ALTER TABLE "agents"."agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_usage_non_negative_ck";
ALTER TABLE "agents"."agent_actions" ADD CONSTRAINT "agent_actions_usage_non_negative_ck"
  CHECK ("input_tokens" >= 0 AND "output_tokens" >= 0 AND "cost" >= 0);

-- A refusal without a code is unexplainable after the fact, which is the one
-- thing this table exists to prevent. A code on a non-refusal is a mislabelled
-- row that would poison every "why was this stopped" query.
ALTER TABLE "agents"."agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_refusal_coded_ck";
ALTER TABLE "agents"."agent_actions" ADD CONSTRAINT "agent_actions_refusal_coded_ck"
  CHECK (("status" = 'refused') = ("refusal_code" IS NOT NULL));

-- A refused action must not carry usage: nothing ran, so nothing was spent,
-- and a refusal with tokens on it would inflate a bill for work never done.
ALTER TABLE "agents"."agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_refusal_free_ck";
ALTER TABLE "agents"."agent_actions" ADD CONSTRAINT "agent_actions_refusal_free_ck"
  CHECK ("status" <> 'refused' OR ("input_tokens" = 0 AND "output_tokens" = 0 AND "cost" = 0));

-- Every row must be renderable to the user it belongs to.
ALTER TABLE "agents"."agent_actions" DROP CONSTRAINT IF EXISTS "agent_actions_message_key_ck";
ALTER TABLE "agents"."agent_actions" ADD CONSTRAINT "agent_actions_message_key_ck"
  CHECK (length("user_message_key") > 0);

-- APPEND-ONLY, IN THE DATABASE.
--
-- §8.2's Agentic Law is only worth anything if the log cannot be edited by the
-- thing it is a log of. The service has no code path that updates or deletes an
-- action; this trigger means a future one could not either, and neither could a
-- psql session belonging to the service role.
--
-- Whole-table truncation is deliberately NOT trapped. It is an owner-only
-- privilege — held by the migration role, not by the runtime role a deployed
-- service connects with — and leaving it available is what lets a test database
-- be reset. In production the runtime cannot reach it; correcting a bad row is
-- done by appending a correcting row, exactly as it is on the ledger.
CREATE OR REPLACE FUNCTION "agents"."agent_actions_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent_actions is append-only: % is not permitted (Agentic Law, §8.2)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "agent_actions_no_update" ON "agents"."agent_actions";
CREATE TRIGGER "agent_actions_no_update"
  BEFORE UPDATE ON "agents"."agent_actions"
  FOR EACH ROW EXECUTE FUNCTION "agents"."agent_actions_append_only"();

DROP TRIGGER IF EXISTS "agent_actions_no_delete" ON "agents"."agent_actions";
CREATE TRIGGER "agent_actions_no_delete"
  BEFORE DELETE ON "agents"."agent_actions"
  FOR EACH ROW EXECUTE FUNCTION "agents"."agent_actions_append_only"();

-- ── usage_windows ────────────────────────────────────────────────────────────
-- The billing period. Sealing it is what makes settlement idempotent.

CREATE TABLE IF NOT EXISTS "agents"."usage_windows" (
  "session_id"      uuid NOT NULL REFERENCES "agents"."agent_sessions"("id"),
  "window_id"       text NOT NULL,
  "opened_at"       timestamptz NOT NULL DEFAULT now(),
  "sealed_at"       timestamptz,
  "charged_amount"  numeric(38, 18),
  "charge_key"      text,
  "charge_tx_id"    text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("session_id", "window_id")
);

CREATE INDEX IF NOT EXISTS "usage_windows_unsealed_idx" ON "agents"."usage_windows" ("sealed_at");

-- A sealed window without an amount and a charge key cannot be reconciled
-- against the ledger, which is the only reason to record the seal at all.
ALTER TABLE "agents"."usage_windows" DROP CONSTRAINT IF EXISTS "usage_windows_seal_complete_ck";
ALTER TABLE "agents"."usage_windows" ADD CONSTRAINT "usage_windows_seal_complete_ck"
  CHECK ("sealed_at" IS NULL OR ("charged_amount" IS NOT NULL AND "charge_key" IS NOT NULL));

-- An unsealed window that already claims a charge would be billed again by the
-- next settlement run.
ALTER TABLE "agents"."usage_windows" DROP CONSTRAINT IF EXISTS "usage_windows_unsealed_uncharged_ck";
ALTER TABLE "agents"."usage_windows" ADD CONSTRAINT "usage_windows_unsealed_uncharged_ck"
  CHECK ("sealed_at" IS NOT NULL OR ("charged_amount" IS NULL AND "charge_key" IS NULL AND "charge_tx_id" IS NULL));

ALTER TABLE "agents"."usage_windows" DROP CONSTRAINT IF EXISTS "usage_windows_amount_non_negative_ck";
ALTER TABLE "agents"."usage_windows" ADD CONSTRAINT "usage_windows_amount_non_negative_ck"
  CHECK ("charged_amount" IS NULL OR "charged_amount" >= 0);

-- ── usage_records ────────────────────────────────────────────────────────────
-- Exact token counts, priced at the rate in force. No money here.

CREATE TABLE IF NOT EXISTS "agents"."usage_records" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id"                uuid NOT NULL,
  "window_id"                 text NOT NULL,
  "request_id"                text NOT NULL,
  "task"                      text NOT NULL,
  "provider_id"               text NOT NULL,
  "model"                     text NOT NULL,
  "input_tokens"              bigint NOT NULL,
  "output_tokens"             bigint NOT NULL,
  "input_price_per_million"   numeric(38, 18) NOT NULL,
  "output_price_per_million"  numeric(38, 18) NOT NULL,
  "recorded_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "usage_records_window_fk"
    FOREIGN KEY ("session_id", "window_id")
    REFERENCES "agents"."usage_windows" ("session_id", "window_id")
);

-- THE ANTI-DOUBLE-BILL CONSTRAINT.
--
-- A retried completion carries the same request id. The second insert conflicts
-- and is discarded, so the tokens are counted once no matter how many times the
-- caller retries. Everything else about idempotency in this service — the
-- ledger key, the window seal — is a second line behind this one.
CREATE UNIQUE INDEX IF NOT EXISTS "usage_records_request_idx"
  ON "agents"."usage_records" ("session_id", "request_id");
CREATE INDEX IF NOT EXISTS "usage_records_window_idx"
  ON "agents"."usage_records" ("session_id", "window_id");

-- Negative tokens or negative rates would reduce a bill; both are only
-- reachable via a bug or a hand-written INSERT, and both are silent.
ALTER TABLE "agents"."usage_records" DROP CONSTRAINT IF EXISTS "usage_records_non_negative_ck";
ALTER TABLE "agents"."usage_records" ADD CONSTRAINT "usage_records_non_negative_ck"
  CHECK (
    "input_tokens" >= 0 AND "output_tokens" >= 0
    AND "input_price_per_million" >= 0 AND "output_price_per_million" >= 0
  );

-- NO LATE USAGE IN A SETTLED WINDOW.
--
-- Settlement computes a window's bill from the rows present when it runs. If a
-- row could arrive afterwards, either it would never be billed, or a second
-- settlement would post a second charge under a key that is supposed to be
-- unique per window. Refusing the insert makes the seal mean what it says.
--
-- The read is FOR UPDATE. That conflicts with settlement's own FOR UPDATE and
-- with the UPDATE that writes sealed_at. An unlocked read can see a still-open
-- window and then sit in usage_records_window_fk until that UPDATE commits, and
-- it does not run again. The locked read waits with the seal, then sees the
-- committed sealed_at. The lock is held until this insert commits, so a seal
-- cannot land in the gap after the check.
CREATE OR REPLACE FUNCTION "agents"."usage_records_reject_sealed"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  sealed timestamptz;
BEGIN
  SELECT w."sealed_at" INTO sealed
    FROM "agents"."usage_windows" w
   WHERE w."session_id" = NEW."session_id" AND w."window_id" = NEW."window_id"
   FOR UPDATE;

  IF sealed IS NOT NULL THEN
    RAISE EXCEPTION 'usage window % for session % was settled at % and accepts no further usage',
      NEW."window_id", NEW."session_id", sealed
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "usage_records_no_late_usage" ON "agents"."usage_records";
CREATE TRIGGER "usage_records_no_late_usage"
  BEFORE INSERT ON "agents"."usage_records"
  FOR EACH ROW EXECUTE FUNCTION "agents"."usage_records_reject_sealed"();

-- A window is sealed once. Re-sealing would overwrite the recorded charge and
-- break the reconciliation against svc-ledger.
CREATE OR REPLACE FUNCTION "agents"."usage_windows_seal_once"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."sealed_at" IS NOT NULL AND (
       NEW."sealed_at" IS DISTINCT FROM OLD."sealed_at"
    OR NEW."charged_amount" IS DISTINCT FROM OLD."charged_amount"
    OR NEW."charge_key" IS DISTINCT FROM OLD."charge_key"
  ) THEN
    RAISE EXCEPTION 'usage window % for session % is already settled and cannot be re-settled',
      OLD."window_id", OLD."session_id"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "usage_windows_seal_once" ON "agents"."usage_windows";
CREATE TRIGGER "usage_windows_seal_once"
  BEFORE UPDATE ON "agents"."usage_windows"
  FOR EACH ROW EXECUTE FUNCTION "agents"."usage_windows_seal_once"();
