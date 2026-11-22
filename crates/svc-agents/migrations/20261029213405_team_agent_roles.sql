-- svc-agents · business team roles, pool and project limits (AG-governance-01, AG-usage-03)
-- Reversal: 20261029213405_team_agent_roles.down.sql
--
-- Membership is never stored here: it is read from svc-bank's business members
-- through packages/contracts at every call, so a removed member's grants,
-- allocation and project limits stop applying at the next read. These tables hold
-- limits, grants and records of runs only, never a balance: no value moves through
-- them. Each run is charged to the member's own account through the usage window's
-- ledger-client recipe, on that window's own key.

-- One member's grant of one role: allow and deny are kept apart, and deny wins.
-- Change n of a grant has the business key agents:role:<business>:<member>:<role>:<n>,
-- so a retried change applies once and a stale one refuses.
CREATE TABLE IF NOT EXISTS "agents"."team_role_grants" (
  "business_id"     uuid NOT NULL,
  "member_user_id"  text NOT NULL,
  "role"            text NOT NULL,
  "allow"           boolean NOT NULL,
  "deny"            boolean NOT NULL,
  "version"         integer NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "digest"          text NOT NULL,
  "granted_by"      text NOT NULL,
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("business_id", "member_user_id", "role"),
  CONSTRAINT "team_role_grants_role_ck" CHECK ("role" IN ('creator', 'runner', 'approver', 'log_reader', 'spend_reader')),
  CONSTRAINT "team_role_grants_version_ck" CHECK ("version" > 0)
);

-- The business pool: a limit on what members' runs may spend, never a balance.
-- Change n has the business key agents:pool:<business>:<n>.
CREATE TABLE IF NOT EXISTS "agents"."team_pools" (
  "business_id"     uuid PRIMARY KEY,
  "asset_id"        text NOT NULL,
  "pool_limit"      numeric(38, 18) NOT NULL,
  "version"         integer NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "digest"          text NOT NULL,
  "set_by"          text NOT NULL,
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_pools_limit_ck" CHECK ("pool_limit" > 0),
  CONSTRAINT "team_pools_version_ck" CHECK ("version" > 0)
);

CREATE TABLE IF NOT EXISTS "agents"."team_pool_allocations" (
  "business_id"     uuid NOT NULL REFERENCES "agents"."team_pools" ("business_id"),
  "member_user_id"  text NOT NULL,
  "amount"          numeric(38, 18) NOT NULL,
  PRIMARY KEY ("business_id", "member_user_id"),
  CONSTRAINT "team_pool_allocations_nonnegative_ck" CHECK ("amount" >= 0)
);

-- A business project and the members its limit applies to. Project n of a business
-- has the business key agents:project:<business>:<n>.
CREATE TABLE IF NOT EXISTS "agents"."team_projects" (
  "id"              uuid PRIMARY KEY,
  "business_id"     uuid NOT NULL,
  "name"            text NOT NULL,
  "asset_id"        text NOT NULL,
  "project_limit"   numeric(38, 18) NOT NULL,
  "seq"             integer NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "digest"          text NOT NULL,
  "created_by"      text NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_projects_limit_ck" CHECK ("project_limit" > 0),
  CONSTRAINT "team_projects_name_ck" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "team_projects_seq_uq" UNIQUE ("business_id", "seq")
);
CREATE INDEX IF NOT EXISTS "team_projects_business_idx" ON "agents"."team_projects" ("business_id", "created_at");

CREATE TABLE IF NOT EXISTS "agents"."team_project_members" (
  "project_id"      uuid NOT NULL REFERENCES "agents"."team_projects" ("id"),
  "member_user_id"  text NOT NULL,
  PRIMARY KEY ("project_id", "member_user_id")
);

-- A run session a member opened on the business's pool. The session itself is an
-- own-agent session (agents.agent_sessions); this row ties it to the business, so
-- every hold on it is checked against the member's allocation, the pool and the
-- member's projects under the business lock.
CREATE TABLE IF NOT EXISTS "agents"."team_sessions" (
  "session_id"      uuid PRIMARY KEY REFERENCES "agents"."agent_sessions" ("id"),
  "business_id"     uuid NOT NULL,
  "member_user_id"  text NOT NULL,
  "own_agent_id"    text NOT NULL,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "team_sessions_business_idx" ON "agents"."team_sessions" ("business_id", "member_user_id");

-- An action a team agent proposed that its guardrail held for approval. Held
-- action n of a business has the business key agents:hold:<business>:<n>. The
-- person who built the agent never approves it: four eyes, held here too.
CREATE TABLE IF NOT EXISTS "agents"."team_held_actions" (
  "id"              uuid PRIMARY KEY,
  "business_id"     uuid NOT NULL,
  "own_agent_id"    text NOT NULL,
  "creator_user_id" text NOT NULL,
  "tool"            text NOT NULL,
  "seq"             integer NOT NULL,
  "idempotency_key" text NOT NULL UNIQUE,
  "status"          text NOT NULL DEFAULT 'held',
  "approved_by"     text,
  "approved_at"     timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "team_held_actions_seq_uq" UNIQUE ("business_id", "seq"),
  CONSTRAINT "team_held_actions_status_ck" CHECK ("status" IN ('held', 'approved')),
  CONSTRAINT "team_held_actions_approved_ck" CHECK (("status" = 'approved') = ("approved_by" IS NOT NULL)),
  CONSTRAINT "team_held_actions_four_eyes_ck" CHECK ("approved_by" IS NULL OR "approved_by" <> "creator_user_id")
);
