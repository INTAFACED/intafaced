-- svc-agents · test runs of a person's own agent: dry runs of one tool call (AG-spend-04, AG-testing-01; J-agents-04 #3, #4)
-- Reversal: 20261104163552_own_agent_test_runs.down.sql
--
-- A dry run checks one call of one of the agent's tools the way a real call is checked and stores what it found and what
-- the call would do. Nothing runs: no session, no ledger entry, no intent and no reservation. Every row is a test run,
-- labelled TEST, never billed, listed apart from live runs and left out of live analytics by default. Keyed
-- agents:test-run:<agent>:<request id>, so the same request again is the same dry run. Nothing here is a balance.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_test_runs" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"    text NOT NULL,
  "request_id"  text NOT NULL,
  "request_key" text NOT NULL,
  "kind"        text NOT NULL,
  "tool"        text NOT NULL,
  "input_json"  jsonb NOT NULL,
  "checks_json" jsonb NOT NULL,
  "effect_json" jsonb NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_test_runs_kind_ck" CHECK ("kind" IN ('dry_run')),
  CONSTRAINT "own_agent_test_runs_key_uq" UNIQUE ("owner_id", "request_key")
);
CREATE INDEX IF NOT EXISTS "own_agent_test_runs_agent_idx"
  ON "agents"."own_agent_test_runs" ("owner_id", "agent_id", "created_at" DESC);
