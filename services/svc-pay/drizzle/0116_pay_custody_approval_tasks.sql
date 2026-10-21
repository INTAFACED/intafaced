-- Custody approval tasks, admin quorum and approver registry (W-custody-ops-06, wallet-custody-ops-027 / 028 / 029). NO BALANCE LIVES HERE.
-- A task freezes one payload (a custody transaction or a workspace configuration change) under a payload hash. It runs only
-- when an owner-set number of DISTINCT registered approvers, none of them the initiator, have approved that exact hash before
-- the deadline. The quorum is owner-set per task kind and read from its latest event: with no row a task refuses, nothing has a
-- default. Decisions are one row per approver, so approving twice is one row. Quorum, approver and event histories are never
-- updated or deleted; an approver is revoked by a new row.
CREATE TABLE IF NOT EXISTS "pay"."custody_task_quorum_events" (
  "seq" bigserial PRIMARY KEY,
  "kind" text NOT NULL,
  "required_approvals" integer NOT NULL,
  "expiry_seconds" integer NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_task_quorum_kind_ck" CHECK ("kind" IN ('custody_transaction', 'config')),
  CONSTRAINT "custody_task_quorum_required_positive" CHECK ("required_approvals" >= 1),
  CONSTRAINT "custody_task_quorum_expiry_positive" CHECK ("expiry_seconds" > 0),
  CONSTRAINT "custody_task_quorum_set_by_ck" CHECK (length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_task_quorum_latest_idx" ON "pay"."custody_task_quorum_events" ("kind", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."custody_approver_events" (
  "seq" bigserial PRIMARY KEY,
  "user_id" text NOT NULL,
  "label" text NOT NULL,
  "role" text NOT NULL,
  "active" boolean NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_approver_role_ck" CHECK ("role" IN ('founder', 'keyless')),
  CONSTRAINT "custody_approver_text_ck" CHECK (length(btrim("user_id")) > 0 AND length(btrim("label")) > 0 AND length(btrim("set_by")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_approver_latest_idx" ON "pay"."custody_approver_events" ("user_id", "seq" DESC);

CREATE TABLE IF NOT EXISTS "pay"."custody_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_ref" text NOT NULL,
  "kind" text NOT NULL,
  "scope" text,
  "title" text NOT NULL,
  "payload" jsonb NOT NULL,
  "payload_hash" text NOT NULL,
  "initiator" text NOT NULL,
  "required_approvals" integer NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "failure_code" text,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "decided_at" timestamptz,
  "executed_at" timestamptz,
  CONSTRAINT "custody_tasks_ref_uq" UNIQUE ("client_ref"),
  CONSTRAINT "custody_tasks_kind_ck" CHECK ("kind" IN ('custody_transaction', 'config')),
  CONSTRAINT "custody_tasks_status_ck" CHECK ("status" IN ('pending', 'approved', 'rejected', 'canceled', 'expired', 'failed', 'executed')),
  CONSTRAINT "custody_tasks_required_positive" CHECK ("required_approvals" >= 1),
  CONSTRAINT "custody_tasks_text_ck" CHECK (length(btrim("client_ref")) > 0 AND length(btrim("initiator")) > 0 AND length(btrim("title")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_tasks_status_idx" ON "pay"."custody_tasks" ("status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "custody_tasks_due_idx" ON "pay"."custody_tasks" ("status", "expires_at");

CREATE TABLE IF NOT EXISTS "pay"."custody_task_decisions" (
  "task_id" uuid NOT NULL REFERENCES "pay"."custody_tasks" ("id"),
  "approver_id" text NOT NULL,
  "decision" text NOT NULL,
  "payload_hash" text NOT NULL,
  "decided_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("task_id", "approver_id"),
  CONSTRAINT "custody_task_decisions_ck" CHECK ("decision" IN ('approve', 'reject') AND length(btrim("approver_id")) > 0)
);

CREATE TABLE IF NOT EXISTS "pay"."custody_task_events" (
  "seq" bigserial PRIMARY KEY,
  "task_id" uuid NOT NULL REFERENCES "pay"."custody_tasks" ("id"),
  "kind" text NOT NULL,
  "actor_id" text NOT NULL,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "custody_task_events_actor_not_blank" CHECK (length(btrim("actor_id")) > 0)
);
CREATE INDEX IF NOT EXISTS "custody_task_events_task_idx" ON "pay"."custody_task_events" ("task_id", "seq");

CREATE OR REPLACE FUNCTION "pay"."custody_tasks_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END;
$$;
DROP TRIGGER IF EXISTS "custody_task_quorum_events_append_only_trg" ON "pay"."custody_task_quorum_events";
CREATE TRIGGER "custody_task_quorum_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_task_quorum_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_tasks_append_only"();
DROP TRIGGER IF EXISTS "custody_approver_events_append_only_trg" ON "pay"."custody_approver_events";
CREATE TRIGGER "custody_approver_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_approver_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_tasks_append_only"();
DROP TRIGGER IF EXISTS "custody_task_decisions_append_only_trg" ON "pay"."custody_task_decisions";
CREATE TRIGGER "custody_task_decisions_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_task_decisions"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_tasks_append_only"();
DROP TRIGGER IF EXISTS "custody_task_events_append_only_trg" ON "pay"."custody_task_events";
CREATE TRIGGER "custody_task_events_append_only_trg" BEFORE UPDATE OR DELETE ON "pay"."custody_task_events"
  FOR EACH ROW EXECUTE FUNCTION "pay"."custody_tasks_append_only"();
