-- svc-agents · business team roles, pool and project limits (AG-governance-01, AG-usage-03)
-- Reversal: 20261029213405_team_agent_roles.down.sql
--
-- Membership is never stored here: it is read from svc-pay's team through
-- packages/contracts at every call, so a removed member's grants, allocation and
-- project limits stop applying at the next read. These tables hold limits and
-- grants only, never a balance: no value moves through them.

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
