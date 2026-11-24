-- svc-agents · agent alert rules, their alerts, and this environment's policy overrides (J-agents-16; AG-analytics-02,
-- AG-guardrails-02)
-- Reversal: 20261115150000_agent_alerts_policy_overrides.down.sql
--
-- An operator stores an alert rule: a measure over agent actions (refusal rate, failure rate or cost), a threshold the
-- operator typed (0 is a value, blank is refused before anything is stored), a window length, and optionally one agent.
-- The evaluator writes one alert per rule and window whose measure is above the threshold; the unique key makes a
-- second evaluation of the same window write nothing. An alert is kept whether or not it is delivered: with no delivery
-- vendor connected it stays `pending`.
-- A policy override is this environment's own layer under the owner's managed baseline (AGENTS_POLICY_BASELINE): one
-- choice per tool class, never looser than the baseline (the service refuses that before it stores anything). Nothing
-- here is a balance and no value moves.

CREATE TABLE IF NOT EXISTS "agents"."agent_alert_rules" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"           text NOT NULL,
  "measure"        text NOT NULL,
  "threshold"      numeric(38, 18) NOT NULL,
  "window_minutes" integer NOT NULL,
  "agent_id"       text,
  "created_by"     text NOT NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_alert_rules_name_key" UNIQUE ("name"),
  CONSTRAINT "agent_alert_rules_name_check" CHECK (length("name") BETWEEN 1 AND 80),
  CONSTRAINT "agent_alert_rules_measure_check" CHECK ("measure" IN ('refusal_rate', 'failure_rate', 'cost')),
  CONSTRAINT "agent_alert_rules_threshold_check"
    CHECK ("threshold" >= 0 AND ("measure" = 'cost' OR "threshold" <= 100)),
  CONSTRAINT "agent_alert_rules_window_check" CHECK ("window_minutes" BETWEEN 1 AND 1440)
);

CREATE TABLE IF NOT EXISTS "agents"."agent_alerts" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "rule_id"      uuid NOT NULL REFERENCES "agents"."agent_alert_rules"("id"),
  "window_start" timestamptz NOT NULL,
  "window_end"   timestamptz NOT NULL,
  "action_rows"  integer NOT NULL,
  "value"        numeric(38, 18) NOT NULL,
  "threshold"    numeric(38, 18) NOT NULL,
  "delivery"     text NOT NULL DEFAULT 'pending',
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_alerts_rule_window_key" UNIQUE ("rule_id", "window_start"),
  CONSTRAINT "agent_alerts_rows_check" CHECK ("action_rows" > 0),
  CONSTRAINT "agent_alerts_delivery_check" CHECK ("delivery" IN ('pending', 'sent')),
  CONSTRAINT "agent_alerts_window_check" CHECK ("window_end" > "window_start")
);
CREATE INDEX IF NOT EXISTS "agent_alerts_created_idx" ON "agents"."agent_alerts" ("created_at" DESC, "id");

CREATE TABLE IF NOT EXISTS "agents"."agent_policy_overrides" (
  "data_class" text PRIMARY KEY,
  "choice"     text NOT NULL,
  "set_by"     text NOT NULL,
  "set_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_policy_overrides_class_check" CHECK ("data_class" IN ('own_data', 'market_data', 'draft_write', 'live_write')),
  CONSTRAINT "agent_policy_overrides_choice_check"
    CHECK ("choice" IN ('hand_off', 'ask_before', 'act_on_request', 'act_without_asking'))
);

-- The evaluator reads every agent's actions in one window; the existing indexes lead with the user or the status.
CREATE INDEX IF NOT EXISTS "agent_actions_time_idx" ON "agents"."agent_actions" ("occurred_at");
