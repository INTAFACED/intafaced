-- svc-agents · standing rules, connector-class consent and approval requests for a person's own agent
-- (AG-guardrails-02, AG-guardrails-01; the request row AG-approvals-01 builds on)
-- Reversal: 20261104143745_own_agent_guardrails.down.sql
--
-- A rule narrows what the agent may do with one of its tools: ask before acting, hand it off, act when asked, or act
-- without asking. One rule per tool, keyed agents:rule:<agent>:own:<tool>; saving again replaces the choice.
-- A consent is the person's yes to one class of tools for one agent, keyed agents:consent:<user>:<agent>:<class>;
-- revoking keeps the row with its revoked time. An approval request is a tool call a rule held for the person, keyed
-- agents:approve:<session>:<request id>; the tool has not run. Nothing here is a balance and no value moves.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_rules" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"    text NOT NULL,
  "tool"        text NOT NULL,
  "choice"      text NOT NULL,
  "rule_key"    text NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_rules_choice_ck" CHECK ("choice" IN ('hand_off', 'ask_before', 'act_on_request', 'act_without_asking')),
  CONSTRAINT "own_agent_rules_key_uq" UNIQUE ("owner_id", "rule_key")
);
CREATE INDEX IF NOT EXISTS "own_agent_rules_agent_idx" ON "agents"."own_agent_rules" ("owner_id", "agent_id");

CREATE TABLE IF NOT EXISTS "agents"."own_agent_consents" (
  "agent_id"     uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"     text NOT NULL,
  "data_class"   text NOT NULL,
  "consent_key"  text NOT NULL,
  "granted_at"   timestamptz NOT NULL DEFAULT now(),
  "revoked_at"   timestamptz,
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("owner_id", "agent_id", "data_class"),
  CONSTRAINT "own_agent_consents_class_ck" CHECK ("data_class" IN ('own_data', 'market_data', 'draft_write', 'live_write')),
  CONSTRAINT "own_agent_consents_key_uq" UNIQUE ("consent_key")
);

CREATE TABLE IF NOT EXISTS "agents"."own_agent_approval_requests" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"     uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"     text NOT NULL,
  "session_id"   uuid NOT NULL,
  "tool"         text NOT NULL,
  "input_json"   jsonb NOT NULL,
  "rule_id"      uuid REFERENCES "agents"."own_agent_rules" ("id"),
  "status"       text NOT NULL DEFAULT 'waiting',
  "request_key"  text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "own_agent_approval_requests_status_ck" CHECK ("status" IN ('waiting')),
  CONSTRAINT "own_agent_approval_requests_key_uq" UNIQUE ("owner_id", "request_key")
);
CREATE INDEX IF NOT EXISTS "own_agent_approval_requests_agent_idx"
  ON "agents"."own_agent_approval_requests" ("owner_id", "agent_id", "created_at" DESC);
