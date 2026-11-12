-- svc-agents · which of a person's venue sub-accounts their own agent may act on, and until when (AG-spend-02,
-- J-agents-08 #2)
-- Reversal: 20261111122144_own_agent_account_access.down.sql
--
-- One row per sub-account granted to one agent. A grant names the sub-accounts exactly: granting again ends every row
-- still live for the agent and adds the new ones, in one transaction. Every row carries the end the person set (never
-- blank), and a row past its end allows nothing. The grant is keyed by the person's grant key (agents:access:<agent>:
-- <grant key>), so a retried grant returns the rows it made and never ends them. Nothing here is a balance and no value
-- moves.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_account_access" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"     uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"     text NOT NULL,
  "grant_key"    text NOT NULL,
  "venue_id"     text NOT NULL,
  "venue_owner"  text NOT NULL,
  "sub_account"  text NOT NULL,
  "name"         text NOT NULL,
  "granted_at"   timestamptz NOT NULL DEFAULT now(),
  "ends_at"      timestamptz NOT NULL,
  "ended_at"     timestamptz,
  CONSTRAINT "own_agent_account_access_owner_ck" CHECK ("venue_owner" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "own_agent_account_access_sub_ck" CHECK ("sub_account" ~ '^0x[0-9a-f]{40}$'),
  CONSTRAINT "own_agent_account_access_ends_ck" CHECK ("ends_at" > "granted_at")
);
CREATE UNIQUE INDEX IF NOT EXISTS "own_agent_account_access_grant_uq"
  ON "agents"."own_agent_account_access" ("owner_id", "grant_key", "sub_account");
CREATE INDEX IF NOT EXISTS "own_agent_account_access_agent_idx"
  ON "agents"."own_agent_account_access" ("owner_id", "agent_id") WHERE "ended_at" IS NULL;
