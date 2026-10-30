-- svc-agents · a soft usage alert and a monthly hard limit for one of the person's own agents (AG-usage-03)
-- Reversal: 20261030024029_own_agent_usage_alerts.down.sql
--
-- The person sets them, in the fee asset; a blank one is not set. Spend counted against both is what this agent's
-- runs actually cost this UTC month, committed holds only. Neither is a balance and neither moves value.
--
-- The hard limit refuses a new run once the month's spend reached it (agents.usage.hard_limit_reached); a run already
-- held finishes and commits. The alert is recorded once per agent and month under its business key
-- `agents.usage_alert:<agent id>:<YYYY-MM>`, in the transaction of the commit that reached it, and published from
-- this row until `published_at` is set, so a crash between the two re-publishes rather than loses it.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_usage_limits" (
  "agent_id"     uuid PRIMARY KEY REFERENCES "agents"."own_agents" ("id"),
  "owner_id"     text NOT NULL,
  "alert_at"     numeric(38, 18),
  "hard_limit"   numeric(38, 18),
  "email"        boolean NOT NULL DEFAULT false,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_usage_limits_amounts_ck" CHECK (
    ("alert_at" IS NULL OR "alert_at" > 0) AND ("hard_limit" IS NULL OR "hard_limit" > 0)
  ),
  CONSTRAINT "own_agent_usage_limits_order_ck" CHECK (
    "alert_at" IS NULL OR "hard_limit" IS NULL OR "alert_at" < "hard_limit"
  )
);

CREATE INDEX IF NOT EXISTS "own_agent_usage_limits_owner_idx" ON "agents"."own_agent_usage_limits" ("owner_id");

CREATE TABLE IF NOT EXISTS "agents"."own_agent_usage_alerts" (
  "alert_key"     text PRIMARY KEY,
  "agent_id"      uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"      text NOT NULL,
  "month"         text NOT NULL,
  "alert_at"      numeric(38, 18) NOT NULL,
  "spent"         numeric(38, 18) NOT NULL,
  "asset_id"      text NOT NULL,
  "email"         boolean NOT NULL,
  "published_at"  timestamptz,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_usage_alerts_month_ck" CHECK ("month" ~ '^[0-9]{4}-[0-9]{2}$'),
  CONSTRAINT "own_agent_usage_alerts_once_uq" UNIQUE ("agent_id", "month")
);

CREATE INDEX IF NOT EXISTS "own_agent_usage_alerts_unpublished_idx"
  ON "agents"."own_agent_usage_alerts" ("owner_id") WHERE "published_at" IS NULL;
