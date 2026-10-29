-- svc-agents · agents a person builds for themselves (AG-builder-01)
-- Reversal: 20261029164239_own_agents.down.sql
--
-- A draft is the person's own: its tools come only from the addable catalogue
-- (src/own/catalog.ts), never a tool that moves money, and a blank spend cap
-- stays blank. Creating or editing one moves no value.

CREATE TABLE IF NOT EXISTS "agents"."own_agents" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "owner_id"         text NOT NULL,
  "template"         text NOT NULL,
  "name"             text NOT NULL DEFAULT '',
  "instructions"     text NOT NULL DEFAULT '',
  "tools"            jsonb NOT NULL DEFAULT '[]'::jsonb,
  "per_session_cap"  numeric(38, 18),
  "version"          integer NOT NULL DEFAULT 1,
  "state"            text NOT NULL DEFAULT 'draft',
  "create_key"       text NOT NULL,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agents_create_key_uq" UNIQUE ("owner_id", "create_key"),
  CONSTRAINT "own_agents_state_ck" CHECK ("state" IN ('draft', 'published')),
  CONSTRAINT "own_agents_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "own_agents_cap_ck" CHECK ("per_session_cap" IS NULL OR "per_session_cap" > 0),
  CONSTRAINT "own_agents_tools_ck" CHECK (jsonb_typeof("tools") = 'array'),
  CONSTRAINT "own_agents_name_ck" CHECK (char_length("name") <= 64),
  CONSTRAINT "own_agents_instructions_ck" CHECK (char_length("instructions") <= 4000)
);

CREATE INDEX IF NOT EXISTS "own_agents_owner_idx" ON "agents"."own_agents" ("owner_id", "created_at");
