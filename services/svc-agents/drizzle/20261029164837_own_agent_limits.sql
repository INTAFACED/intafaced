-- svc-agents · the person's own caps for one of their own agents (AG-spend-01)
-- Reversal: 20261029164837_own_agent_limits.down.sql
--
-- Per call, per session and per month, in the fee asset. Set only by the agent's
-- owner; a run of the agent holds its worst case against all three before the
-- engine is called. No row means no cap: a session refuses agents.spend.cap_unset.
-- A cap is not a balance and moves no value.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_limits" (
  "agent_id"     uuid PRIMARY KEY REFERENCES "agents"."own_agents" ("id"),
  "owner_id"     text NOT NULL,
  "per_call"     numeric(38, 18) NOT NULL,
  "per_session"  numeric(38, 18) NOT NULL,
  "per_period"   numeric(38, 18) NOT NULL,
  "period"       text NOT NULL,
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_limits_amounts_ck" CHECK ("per_call" >= 0 AND "per_session" >= 0 AND "per_period" >= 0),
  CONSTRAINT "own_agent_limits_period_ck" CHECK ("period" IN ('month'))
);

CREATE INDEX IF NOT EXISTS "own_agent_limits_owner_idx" ON "agents"."own_agent_limits" ("owner_id");
