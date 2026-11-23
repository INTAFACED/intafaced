-- svc-agents · what a person's own agent remembers, the person's data controls for it, and its share with co-owners
-- (AG-builder-02, AG-guardrails-04; J-agents-09)
-- Reversal: 20261113213343_own_agent_memory.down.sql
--
-- A remembered item is short text the person asked the agent to remember, written only by a run's visible `remember`
-- step and keyed by that run (agents:memory:<run>:1), so a retried run never writes it twice. Clearing an item is one
-- delete of that row; the run that remembered it keeps its log. One data-control row per agent: memory on or off
-- (on until the person switches it off), whether transcripts are kept, and what the agent shares with its co-owners.
-- A test run records what it did with a request to remember in `memory_json`. Nothing here is a balance and no value
-- moves.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_memory" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"      uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"      text NOT NULL,
  "item_key"      text NOT NULL,
  "text"          text NOT NULL,
  "source_run_id" uuid NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_memory_text_ck" CHECK (length("text") BETWEEN 1 AND 500)
);
CREATE UNIQUE INDEX IF NOT EXISTS "own_agent_memory_key_uq" ON "agents"."own_agent_memory" ("owner_id", "item_key");
CREATE INDEX IF NOT EXISTS "own_agent_memory_agent_idx" ON "agents"."own_agent_memory" ("owner_id", "agent_id", "created_at");

CREATE TABLE IF NOT EXISTS "agents"."own_agent_data_controls" (
  "agent_id"           uuid PRIMARY KEY REFERENCES "agents"."own_agents" ("id"),
  "owner_id"           text NOT NULL,
  "memory_enabled"     boolean NOT NULL DEFAULT true,
  "keep_transcripts"   boolean NOT NULL DEFAULT false,
  "share_transcripts"  boolean NOT NULL DEFAULT false,
  "share_memory"       boolean NOT NULL DEFAULT false,
  "shared_at"          timestamptz,
  "updated_at"         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "agents"."own_agent_test_runs" ADD COLUMN IF NOT EXISTS "memory_json" jsonb;
