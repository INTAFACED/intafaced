-- svc-agents · publishing a person's own agent to surfaces, its co-owners (AG-builder-03; J-agents-03 #7, #8)
-- Reversal: 20261104183600_own_agent_publishing.down.sql
--
-- A published version is a copy of the agent as it was published and never changes: an UPDATE of one is refused here,
-- whatever asks. Each surface carries one published version of the agent; publishing moves only the surfaces chosen.
-- A co-owner is one person's account id, never the agent's owner. Nothing here moves value or holds a balance.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_versions" (
  "agent_id"         uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"         text NOT NULL,
  "version"          integer NOT NULL,
  "name"             text NOT NULL,
  "instructions"     text NOT NULL,
  "tools"            jsonb NOT NULL,
  "per_session_cap"  numeric(38, 18),
  "published_at"     timestamptz NOT NULL DEFAULT now(),
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_versions_pk" PRIMARY KEY ("agent_id", "version"),
  CONSTRAINT "own_agent_versions_version_ck" CHECK ("version" >= 1),
  CONSTRAINT "own_agent_versions_tools_ck" CHECK (jsonb_typeof("tools") = 'array')
);

CREATE OR REPLACE FUNCTION "agents"."own_agent_versions_immutable"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'agents.own.version_immutable' USING ERRCODE = 'check_violation';
END;
$$;

DROP TRIGGER IF EXISTS "own_agent_versions_immutable_trg" ON "agents"."own_agent_versions";
CREATE TRIGGER "own_agent_versions_immutable_trg"
  BEFORE UPDATE ON "agents"."own_agent_versions"
  FOR EACH ROW EXECUTE FUNCTION "agents"."own_agent_versions_immutable"();

CREATE TABLE IF NOT EXISTS "agents"."own_agent_surfaces" (
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"    text NOT NULL,
  "surface"     text NOT NULL,
  "version"     integer NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_surfaces_pk" PRIMARY KEY ("agent_id", "surface"),
  CONSTRAINT "own_agent_surfaces_surface_ck" CHECK ("surface" IN ('my_agents', 'chat')),
  CONSTRAINT "own_agent_surfaces_version_fk" FOREIGN KEY ("agent_id", "version")
    REFERENCES "agents"."own_agent_versions" ("agent_id", "version")
);

CREATE TABLE IF NOT EXISTS "agents"."own_agent_co_owners" (
  "agent_id"     uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"     text NOT NULL,
  "co_owner_id"  text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_co_owners_pk" PRIMARY KEY ("agent_id", "co_owner_id"),
  CONSTRAINT "own_agent_co_owners_not_owner_ck" CHECK ("co_owner_id" <> "owner_id")
);
CREATE INDEX IF NOT EXISTS "own_agent_co_owners_co_owner_idx" ON "agents"."own_agent_co_owners" ("co_owner_id");

