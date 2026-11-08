-- svc-agents · allow and deny rules for what a person's own agent may do, by action and account scope (AG-spend-02,
-- J-agents-08 #1)
-- Reversal: 20261108193804_own_agent_policy_rules.down.sql
--
-- A rule allows or denies one action (place, cancel or amend an order) at one scope (all of the person's accounts, or
-- the main account). A deny at any scope that covers the account wins whatever order the rules were written in. With
-- rules required, an action no rule allows is refused. A live rule is keyed agents:policy:<agent>:<effect>:<action>:<scope>;
-- adding it again returns the stored row, and removing it keeps the row with its removal time. Nothing here is a
-- balance and no value moves.

CREATE TABLE IF NOT EXISTS "agents"."own_agent_policy_rules" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "agent_id"    uuid NOT NULL REFERENCES "agents"."own_agents" ("id"),
  "owner_id"    text NOT NULL,
  "effect"      text NOT NULL,
  "action"      text NOT NULL,
  "scope"       text NOT NULL,
  "rule_key"    text NOT NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "removed_at"  timestamptz,
  CONSTRAINT "own_agent_policy_rules_effect_ck" CHECK ("effect" IN ('allow', 'deny')),
  CONSTRAINT "own_agent_policy_rules_action_ck" CHECK ("action" IN ('place_order', 'cancel_order', 'amend_order')),
  CONSTRAINT "own_agent_policy_rules_scope_ck" CHECK ("scope" IN ('all', 'main'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "own_agent_policy_rules_live_uq"
  ON "agents"."own_agent_policy_rules" ("owner_id", "rule_key") WHERE "removed_at" IS NULL;
CREATE INDEX IF NOT EXISTS "own_agent_policy_rules_agent_idx" ON "agents"."own_agent_policy_rules" ("owner_id", "agent_id");

CREATE TABLE IF NOT EXISTS "agents"."own_agent_policy_settings" (
  "agent_id"        uuid PRIMARY KEY REFERENCES "agents"."own_agents" ("id"),
  "owner_id"        text NOT NULL,
  "rules_required"  boolean NOT NULL DEFAULT false,
  "updated_at"      timestamptz NOT NULL DEFAULT now()
);
