-- svc-agents · the operator's fleet registry and its switches (AG-registry-01, AG-control-02)
-- Reversal: 20261107090741_agent_fleet_control.down.sql
--
-- An agent on the platform is named by a reference: `product:<agent_id>` for a row of agent_definitions, or
-- `own:<uuid>` for an agent a person built (own_agents).
--
-- `agent_switches`: one row per agent an operator quarantined, with who did it and why. A restore takes two distinct
-- founders: the first press records `restore_requested_by`; a different founder confirming deletes the row (the audit
-- keeps the history). A product agent's quarantine also sets agent_definitions.enabled to false, which a boot
-- re-register preserves.
--
-- `agent_kind_switches`: one row per kind an operator switched off in one action. A restart reads the row again, so it
-- never re-enables the kind. Its restore takes two distinct founders the same way.
--
-- `agent_owner_assignments`: the owner an operator gave an agent that had none. It names an owner of record; it grants
-- that person no control of the agent.
--
-- `agent_fleet_audit`: one row per operator action or registry export, on a business key, so a retried request writes
-- no second row. Append-only.

CREATE TABLE IF NOT EXISTS "agents"."agent_switches" (
  "agent_ref"             text PRIMARY KEY,
  "reason"                text NOT NULL,
  "set_by"                text NOT NULL,
  "set_at"                timestamptz NOT NULL DEFAULT now(),
  "restore_requested_by"  text,
  "restore_requested_at"  timestamptz,
  CONSTRAINT "agent_switches_ref_ck" CHECK ("agent_ref" ~ '^(product|own):.+$'),
  CONSTRAINT "agent_switches_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "agent_switches_restore_ck" CHECK (("restore_requested_by" IS NULL) = ("restore_requested_at" IS NULL))
);

CREATE TABLE IF NOT EXISTS "agents"."agent_kind_switches" (
  "kind"                  text PRIMARY KEY,
  "reason"                text NOT NULL,
  "set_by"                text NOT NULL,
  "set_at"                timestamptz NOT NULL DEFAULT now(),
  "restore_requested_by"  text,
  "restore_requested_at"  timestamptz,
  CONSTRAINT "agent_kind_switches_kind_ck" CHECK ("kind" IN ('customer_built', 'product')),
  CONSTRAINT "agent_kind_switches_reason_ck" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "agent_kind_switches_restore_ck" CHECK (("restore_requested_by" IS NULL) = ("restore_requested_at" IS NULL))
);

CREATE TABLE IF NOT EXISTS "agents"."agent_owner_assignments" (
  "agent_ref"    text PRIMARY KEY,
  "owner_id"     text NOT NULL,
  "assigned_by"  text NOT NULL,
  "assigned_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_owner_assignments_ref_ck" CHECK ("agent_ref" ~ '^(product|own):.+$')
);

CREATE TABLE IF NOT EXISTS "agents"."agent_fleet_audit" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "business_key"  text NOT NULL UNIQUE,
  "operator_id"   text NOT NULL,
  "action"        text NOT NULL,
  "agent_ref"     text,
  "kind"          text,
  "reason"        text,
  "filter"        jsonb NOT NULL DEFAULT '{}'::jsonb,
  "row_count"     integer,
  "at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_fleet_audit_action_ck" CHECK ("action" IN (
    'export', 'quarantine', 'restore_request', 'restore', 'kill_kind', 'restore_kind_request', 'restore_kind', 'reassign'
  )),
  CONSTRAINT "agent_fleet_audit_rows_ck" CHECK ("row_count" IS NULL OR "row_count" >= 0)
);

CREATE INDEX IF NOT EXISTS "agent_fleet_audit_ref_idx" ON "agents"."agent_fleet_audit" ("agent_ref", "at");

CREATE OR REPLACE FUNCTION "agents"."agent_fleet_audit_append_only"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent_fleet_audit is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS "agent_fleet_audit_no_update" ON "agents"."agent_fleet_audit";
CREATE TRIGGER "agent_fleet_audit_no_update"
  BEFORE UPDATE ON "agents"."agent_fleet_audit"
  FOR EACH ROW EXECUTE FUNCTION "agents"."agent_fleet_audit_append_only"();

DROP TRIGGER IF EXISTS "agent_fleet_audit_no_delete" ON "agents"."agent_fleet_audit";
CREATE TRIGGER "agent_fleet_audit_no_delete"
  BEFORE DELETE ON "agents"."agent_fleet_audit"
  FOR EACH ROW EXECUTE FUNCTION "agents"."agent_fleet_audit_append_only"();

-- `own_agent_background_runs`: a person's test run of their own agent that goes on in the background, one step at a
-- time (AG-control-02, ENGINE KS-4). Before each step the run re-reads the agent's switches; a quarantine or a kind
-- kill stops it there, as `stopped` with the code that stopped it. Mode test, cost 0, labelled TEST: never billed, no
-- session, reservation, usage row or ledger call.
CREATE TABLE IF NOT EXISTS "agents"."own_agent_background_runs" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"     text NOT NULL,
  "agent_id"     uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "request_key"  text NOT NULL,
  "ask"          text NOT NULL,
  "steps_total"  integer NOT NULL,
  "steps_done"   integer NOT NULL DEFAULT 0,
  "state"        text NOT NULL DEFAULT 'running',
  "stop_code"    text,
  "started_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_background_runs_key_uq" UNIQUE ("owner_id", "request_key"),
  CONSTRAINT "own_agent_background_runs_state_ck" CHECK ("state" IN ('running', 'done', 'stopped')),
  CONSTRAINT "own_agent_background_runs_steps_ck" CHECK ("steps_total" >= 1 AND "steps_done" BETWEEN 0 AND "steps_total"),
  CONSTRAINT "own_agent_background_runs_stop_ck" CHECK (("state" = 'stopped') = ("stop_code" IS NOT NULL)),
  CONSTRAINT "own_agent_background_runs_ask_ck" CHECK (char_length("ask") <= 4000)
);

CREATE INDEX IF NOT EXISTS "own_agent_background_runs_agent_idx"
  ON "agents"."own_agent_background_runs" ("owner_id", "agent_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "own_agent_background_runs_running_idx"
  ON "agents"."own_agent_background_runs" ("state") WHERE "state" = 'running';
